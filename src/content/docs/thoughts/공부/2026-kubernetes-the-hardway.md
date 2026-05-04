---
title: Kubernetes The Hard Way
lastUpdated: 2026-01-06T22:30:00
tags: ["Kubernetes", "리눅스", "PKI", "네트워크"]
---

[Kubernetes The Hard Way](https://github.com/kelseyhightower/kubernetes-the-hard-way) 가이드를 따라가며 k8s에 대해 깊게 이해해보자.

원본 가이드는 Debian 12 머신 4대(jumpbox 1, control plane 서버 1, worker 2)를 요구하고 가상화 방식은 자유다. 다만 control plane이 단일 노드라 HA 구성을 살펴보기는 어렵다. 이 글에서는 control plane을 3대로 늘리고 앞단에 LB를 두는 HA 구성으로 확장했다.

본인은 ARM Linux 호스트에서 [KVM](https://www.linux-kvm.org/)/[libvirt](https://libvirt.org/) VM 6대를 띄워 진행했고, 호스트 자체는 jumpbox로 사용한다. 가상화 방식은 본인 환경에 맞게 골라도 될 듯 하다.

| 호스트 | IP             | 띄울 컴포넌트                   |
| ------ | -------------- | ------------------------------- |
| lb     | 192.168.122.10 | HAProxy (TCP passthrough :6443) |
| cp1    | 192.168.122.11 | etcd, apiserver, cm, scheduler  |
| cp2    | 192.168.122.12 | etcd, apiserver, cm, scheduler  |
| cp3    | 192.168.122.13 | etcd, apiserver, cm, scheduler  |
| w1     | 192.168.122.21 | containerd, kubelet, kube-proxy |
| w2     | 192.168.122.22 | containerd, kubelet, kube-proxy |

## TLS & Certs

K8s는 모든 컴포넌트 간 통신에 mTLS를 쓰므로 cert와 그걸 서명할 CA부터 먼저 만들어야 한다.

### PKI

K8s의 모든 컴포넌트는 서로 통신할 때 mTLS로 양방향 인증을 한다. 그러려면 cert가 필요하고, cert가 신뢰받으려면 CA(Certificate Authority)가 서명해야 한다. 여기서는 공인 CA(DigiCert, Let's Encrypt 등) 대신 직접 root CA를 만들고, 인증서 생성 도구로는 Cloudflare가 자체 PKI 운영을 위해 만든 도구인 [cfssl](https://github.com/cloudflare/cfssl)을 사용한다.

```bash
cfssl gencert -initca ca-csr.json | cfssljson -bare ca
```

이 한 줄로 root CA 인증서(`ca.pem`)와 개인 키(`ca-key.pem`)가 만들어진다. 이후 모든 cert는 이 CA로 서명한다. `ca-key.pem`이 유출되면 임의의 신원으로 cert를 위조할 수 있으니 보관에 주의한다.

**왜 공인 CA가 아니라 자체 CA를 쓸까**

- 공인 CA는 `cp1`, `192.168.122.10` 같은 사설 호스트명/IP에 cert를 발급하지 않는다.
- K8s는 cert의 `CN`을 사용자 이름, `O`를 그룹으로 해석한다. `O=system:masters` 같은 K8s 컨벤션 값을 넣으려면 발급자를 직접 통제해야 한다.
- 클러스터 내부에서만 검증되니 공개 신뢰 체계에 등록할 필요가 없다. `ca.pem`을 컴포넌트에 배포하면 끝이다.
- 만료/재발급/폐기를 직접 결정할 수 있고 외부 의존이 없다.

공인 도메인이 있다면 apiserver의 **서버 cert만** 공인 CA로 발급받는 하이브리드도 가능하다 (`--tls-cert-file`은 Let's Encrypt, `--client-ca-file`은 자체 CA). 다만 클라이언트 인증용 CA를 공인 CA로 두면 그 CA가 서명한 모든 cert가 apiserver에 인증을 시도할 수 있어 위험하다. 클라이언트 쪽은 어떤 환경에서든 자체 CA를 쓴다.

**왜 openssl이 아니라 cfssl를 쓸까**

- cert 요청을 JSON 파일로 정의해 git으로 관리, 재현하기 좋다.
- 명령이 한 줄로 끝난다. openssl처럼 대화형 입력이나 다단계 명령이 없다.
- K8s에서 약 10개의 cert를 발급해야 해서 일괄 생성에 유리하다.

### Subject와 신원

X.509 인증서는 "Subject"라는 항목이 있다. Subject에는 6개 필드로 신원을 표현하는 값이 들어있다.

```
Subject: C=US, ST=Oregon, L=Portland, O=system:masters, OU=CA, CN=admin
```

이 중 K8s가 실제로 보는 건 두 개뿐이다.

- **CN (Common Name)**: 사용자 이름
- **O (Organization)**: 그룹 이름

나머지 4개(`C`, `ST`, `L`, `OU`)는 1980년대 LDAP에서 유래한 필드라 K8s 인증 단계에서는 사용되지 않는다.

K8s API 서버가 들어온 cert를 검증하는 [코드](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/authentication/request/x509/x509.go)는 단순하다.

```go
// staging/src/k8s.io/apiserver/pkg/authentication/request/x509/x509.go
return &authenticator.Response{
  User: &user.DefaultInfo{
    Name:   chain[0].Subject.CommonName,    // CN → username
    Groups: chain[0].Subject.Organization,  // O → groups
  },
}, true, nil
```

`O=system:masters`가 들어 있는 cert로 접속하면 `system:masters` 그룹으로 인식되고 cluster-admin 권한이 부여된다. [RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)을 명시적으로 설정하지 않아도 admin이 동작하는 이유다. K8s는 부팅 시 [빌트인 ClusterRoleBinding](https://github.com/kubernetes/kubernetes/blob/master/plugin/pkg/auth/authorizer/rbac/bootstrappolicy/policy.go) 50여 개를 etcd에 자동으로 등록하는데, `system:masters → cluster-admin`도 그 중 하나다.

`O=system:nodes, CN=system:node:w1`이 들어 있는 cert로 접속하면 워커 w1의 신원으로 인식되고, [Node Authorizer](https://kubernetes.io/docs/reference/access-authn-authz/node/)([source](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/auth/authorizer/node))가 동작해 자기 노드의 자원만 접근하도록 제한한다.

결국 cert를 어떻게 만드는지가 권한 범위를 결정한다.

### 컴포넌트별 cert

각 컴포넌트마다 신원이 다르므로 cert도 다르다.

| Cert                    | CN                             | O                   | 용도                     |
| ----------------------- | ------------------------------ | ------------------- | ------------------------ |
| admin                   | admin                          | system:masters      | kubectl 관리자           |
| w1                      | system:node:w1                 | system:nodes        | w1의 kubelet             |
| w2                      | system:node:w2                 | system:nodes        | w2의 kubelet             |
| kube-controller-manager | system:kube-controller-manager | (동일)              | cm                       |
| kube-proxy              | system:kube-proxy              | system:node-proxier | kube-proxy               |
| kube-scheduler          | system:kube-scheduler          | (동일)              | scheduler                |
| kubernetes              | kubernetes                     | Kubernetes          | apiserver/etcd 서버 cert |
| service-account         | service-accounts               | Kubernetes          | SA 토큰 JWT 서명         |

Subject(CN/O)는 클라이언트 cert에서 신원으로 쓰인다. 서버 cert에는 또 다른 항목이 필요하다.

### SAN

서버 cert의 핵심 항목은 SAN(Subject Alternative Name)이다.

```
X509v3 Subject Alternative Name:
    DNS: cp1, cp2, cp3, lb, kubernetes.default.svc.cluster.local
    IP:  127.0.0.1, 10.32.0.1, 192.168.122.11, 192.168.122.12, 192.168.122.13, 192.168.122.10
```

클라이언트가 `https://lb:6443`에 접속하면 TLS 핸드셰이크에서 cert의 SAN에 `lb`가 있는지 검사한다. 없으면 `x509: certificate is valid for X, not lb` 에러로 실패한다.

`kubernetes.pem`의 SAN에는 18개 항목이 들어간다. apiserver가 어떤 경로로 불려도 검증을 통과해야 하기 때문이다.

- `127.0.0.1`: apiserver 자기 자신의 health check
- `10.32.0.1`: Service CIDR 첫 IP. Pod 안에서 `kubernetes` Service에 붙을 때 사용된다
- `192.168.122.11/12/13`: cp 직접 IP
- `192.168.122.10`: lb. 워커가 LB 경유해서 부를 때 사용된다
- `cp1, cp2, cp3, lb`: 호스트명
- `kubernetes.default.svc.cluster.local`: Pod이 in-cluster DNS로 부를 때의 가장 긴 형태

CN은 cert의 신원을 표현하는 단일 값이고, SAN은 cert가 응답할 수 있는 호스트명/IP의 목록이다. 둘 다 들어 있는 cert는 클라이언트와 서버 양방향으로 작동한다.

### kubeconfig

cert와 키를 가지고 있어도 컴포넌트가 그걸 쓰려면 누구로 어디에 붙을지 정보가 필요하다. 그 정보를 담는 파일이 kubeconfig다.

YAML 파일이고, 3개 블록 + 1개 포인터로 구성된다.

```yaml
clusters: # 어느 apiserver에 붙을지
  - name: my-cluster
    cluster:
      server: https://lb:6443
      certificate-authority-data: <base64 ca.pem>

users: # 누구로 인증할지
  - name: admin
    user:
      client-certificate-data: <base64 admin.pem>
      client-key-data: <base64 admin-key.pem>

contexts: # context 설정
  - name: default
    context:
      cluster: my-cluster
      user: admin

current-context: default
```

6개 kubeconfig를 만든다. 각 컴포넌트가 자기 cert로 자기 위치에서 클러스터에 접속하기 위한 설정이다.

server URL은 컴포넌트가 어디서 도느냐에 따라 다르다.

- 워커의 kubelet, kube-proxy → `https://lb:6443`. cp 한 대가 죽어도 다른 cp로 넘어가야 하니 LB를 거친다.
- cp의 controller-manager, scheduler → `https://127.0.0.1:6443`. 같은 노드에 apiserver가 떠 있으니 굳이 LB를 거칠 이유가 없다.

### TLS Bootstrap

여기까지는 jumpbox에서 cfssl로 발급한 cert(`CN=system:node:w1`, `O=system:nodes` 등)를 scp로 각 노드에 미리 배포해둔 상태를 가정했다. CA 개인키를 jumpbox 밖에 둘 일이 없어 노출 면은 좁다. 다만 노드를 추가할 때마다 사람이 같은 작업을 반복해야 한다.

이를 해결하는 다른 방식은 [TLS bootstrap](https://kubernetes.io/docs/reference/access-authn-authz/kubelet-tls-bootstrapping/)이다. 새 노드가 단기 토큰으로 임시 인증을 통과한 뒤 자기 cert를 클러스터에 요청해 받아오는 방식이라, 노드를 동적으로 추가하는 상황에 유리하다. 흐름은 다음과 같다

1. 관리자가 `kubeadm token create`로 단기 bootstrap token을 만든다.
2. 새 노드의 kubelet이 이 토큰으로 apiserver에 인증한다
   - 이때의 신원은 `system:bootstrappers` 그룹이다
3. kubelet이 자기 노드의 신원(`CN=system:node:w3, O=system:nodes`)으로 [CSR](https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/)을 제출한다.
4. controller-manager의 CSR signer가 CSR을 [CA 개인키로 서명](https://github.com/kubernetes/kubernetes/tree/master/pkg/controller/certificates/signer)한다. RBAC 정책으로 `system:bootstrappers`가 제출한 노드 CSR은 자동 승인된다.
5. kubelet이 서명된 cert를 받아 이후 mTLS에 사용한다. bootstrap token은 만료되거나 폐기된다.

이 흐름이 동작하려면 controller-manager에 CA 개인키가 살아 있어야 한다 (`--cluster-signing-cert-file=ca.pem`, `--cluster-signing-key-file=ca-key.pem`). cp 노드에 CA 키가 상주하는 셈이라 jumpbox에서만 다루는 The Hard Way 방식보다 노출 면이 넓어진다. 대신 노드 합류가 `kubeadm join` 한 줄로 끝나고, cert 만료 전 자동 rotate까지 같은 메커니즘으로 처리된다.

## Control Plane

인증 기반이 갖춰졌으니 컨트롤 플레인 컴포넌트를 차례로 띄워보자. 상태 저장소인 etcd로 시작해 apiserver, controller-manager, scheduler 순으로 올라가고, 마지막에 cp 3대 앞단의 LB를 둔다.

컨트롤 플레인 컴포넌트를 띄우는 방법은 호스트에서 바이너리를 직접 실행하거나, K8s가 관리하는 Pod으로 띄우는 방식 중에 선택할 수 있다.

k8s 공식 클러스터 부트스트랩 CLI 도구인 [kubeadm](https://kubernetes.io/docs/reference/setup-tools/kubeadm/)는 컨트롤 플레인까지 Pod로 실행한다. K8s에는 로그 수집, 헬스 체크, 재시작, 롤링 업데이트 같은 매커니즘이 이미 갖춰져 있으니 컨트롤 플레인도 같은 방식으로 관리하면 운영 일관성을 지킬 수 있다.

그런데 원래는 Pod을 만들려면 apiserver에 요청을 보내야 하는데, 띄우려는 Pod이 apiserver 자신이면 pod를 어떻게 실행할 수 있다는 말일까? 이럴 때 [**static pod**](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)를 사용하는 방법이 있다. kubelet은 평소엔 apiserver의 명령을 받아 Pod을 띄우지만, 동시에 `/etc/kubernetes/manifests` 디렉터리도 [watch](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/config/file.go)한다. 그 폴더에 yaml이 있으면 apiserver와 무관하게 그 yaml을 보고 직접 컨테이너를 띄운다.

apiserver, etcd, cm, scheduler manifest를 미리 깔아두면 kubelet이 이 4개를 static pod으로 띄운다. 일단 apiserver가 살아나면 이후 만들어지는 일반 워크로드 Pod은 정상 경로(클라이언트 → apiserver → etcd write → kubelet)로 처리할 수 있게 된다.

`/etc/kubernetes/manifests/kube-apiserver.yaml`은 대략 이렇게 생겼다 <br>
(kubeadm이 생성하는 파일을 줄여서 옮겼다)

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: kube-apiserver
  namespace: kube-system
spec:
  hostNetwork: true # 호스트 네트워크 그대로 사용
  priorityClassName: system-node-critical
  containers:
    - name: kube-apiserver
      image: registry.k8s.io/kube-apiserver:v1.32.0
      command:
        - kube-apiserver
        - --advertise-address=192.168.122.11
        - --etcd-servers=https://127.0.0.1:2379
        - --client-ca-file=/etc/kubernetes/pki/ca.crt
        - --service-account-key-file=/etc/kubernetes/pki/sa.pub
        - --service-account-signing-key-file=/etc/kubernetes/pki/sa.key
        # ...
      volumeMounts:
        - mountPath: /etc/kubernetes/pki
          name: k8s-certs
          readOnly: true
      livenessProbe:
        httpGet: { host: 127.0.0.1, port: 6443, scheme: HTTPS, path: /livez }
  volumes:
    - hostPath: { path: /etc/kubernetes/pki }
      name: k8s-certs
```

이 yaml을 static pod 경로에 넣으면 kubelet이 자동으로 mirror Pod을 만들어 apiserver에서 `kubectl get pods -n kube-system`으로 보이게 한다. 이 mirror Pod은 읽기 전용이라 apiserver에서 삭제해도 manifest를 안 지우면 다시 살아난다.

The Hard Way에선 컨트롤 플레인을 호스트의 systemd 데몬으로 띄운다. 외부에 있으니 자기 참조가 생기지 않는다. 운영 편의는 떨어지지만 구조가 단순하니 학습용으로 선택해보자.

### etcd

K8s는 클러스터 상태(어떤 Pod이 어디 있고, 어떤 Service의 ClusterIP가 무엇인지 등)를 [etcd](https://etcd.io/)에 저장한다. 분산 KV 저장소를 cp1/cp2/cp3 3대로 띄우고, [raft](https://raft.github.io/) 합의 알고리즘으로 일관성을 유지한다. 한 대가 죽어도 나머지 둘로 quorum이 유지되고, 두 대가 죽으면 read-only 상태가 된다.

etcd도 앞서 얘기한 것처럼 static pod로 생성하는 방법도 있지만, systemd unit으로 띄운다. 여기선 peer 주소를 고정으로 지정해준다. 동적으로 선택해야하는 경우 환경에 따라 SRV DNS, discovery service 등을 선택할 수 있겠다.

```
ExecStart=/usr/local/bin/etcd \
  --name cp1 \
  --initial-cluster cp1=https://192.168.122.11:2380,cp2=https://192.168.122.12:2380,cp3=https://192.168.122.13:2380 \
  --listen-peer-urls https://192.168.122.11:2380 \
  --listen-client-urls https://192.168.122.11:2379,https://127.0.0.1:2379 \
  --cert-file=... --key-file=...                  # apiserver↔etcd TLS
  --peer-cert-file=... --peer-key-file=...        # etcd peer TLS
  --trusted-ca-file=/etc/etcd/ca.pem
  --client-cert-auth                              # mTLS 강제
```

두 개 포트의 역할은 아래처럼 각각 다르다.

- `2379`: 클라이언트(apiserver) 접속 포트. Get/Put/Watch 같은 KV 연산이 들어온다.
- `2380`: peer 포트. etcd 인스턴스끼리 raft 메시지(append entries, vote 등)를 주고받는다.

3대를 거의 동시에 시작해야 quorum이 형성된다. 한 대만 먼저 켜면 나머지 둘을 기다리다 timeout된다. `etcdctl member list`를 실행했을 때 3개 멤버가 보이면 정상이다.

K8s가 일반 RDB나 Redis를 쓰지 않고 etcd를 고른 이유는 두 가지 요구사항 때문이다.

- **선형화 가능한 읽기/쓰기** (linearizable read/write): 모든 컴포넌트가 같은 순서의 변경을 보지 못하면 컨트롤 플레인이 서로 다른 상태로 어긋난다. raft가 이를 보장한다.
- **변경 알림 (watch)**: K8s 컴포넌트는 폴링하지 않고 watch로 이벤트 스트림을 구독한다. apiserver가 받는 watch도 결국 etcd의 [MVCC](https://etcd.io/docs/latest/learning/data_model/) revision 기반 watch 위에서 돌아간다.

etcd의 데이터 구조도 단순한 KV가 아니다. 모든 키가 revision으로 버전 관리된다. apiserver는 클라이언트가 `?resourceVersion=N`으로 watch를 시작하면 etcd에 그 revision부터 변경을 받아 흘려준다. 이 메커니즘이 controller-manager의 reconcile loop가 효율적으로 동작하는 기반이다.

운영시 아래 두가지를 주의해야한다

- **암호화**: etcd 자체는 디스크에 평문으로 쓴다. K8s Secret이 etcd 디스크에 평문으로 남는 걸 막으려면 apiserver에 [`EncryptionConfiguration`](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)을 주고 aescbc 같은 provider를 켜야 한다. Smoke test 단계에서 이를 확인한다.
- **백업**: `etcdctl snapshot save`로 주기적으로 스냅샷을 떠두면 안전하다. 만약 etcd 멤버 3대가 동시에 손상되면 클러스터 전체 상태가 복구 불가능하다.

암호화 설정은 다음과 같이 생겼다. apiserver에 `--encryption-provider-config=...`로 이 파일을 넘기면 적용된다.

```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - aescbc:
          keys:
            - name: key1
              secret: <base64 32B random>
      - identity: {} # 마지막 fallback. 평문 read만 허용
```

provider 목록은 순서가 의미 있다. 쓸 때는 첫 번째 provider(aescbc)로 암호화하고, 읽을 때는 위에서부터 시도해 매칭되는 걸로 복호화한다. 키 회전 시에는 새 키를 첫 번째에 넣고 옛 키를 두 번째로 옮긴 뒤 데이터를 한 번씩 다시 쓰는 식으로 진행한다.

이 시점에서 K8s API는 아직 시작도 안 했지만 분산 합의 시스템은 이미 작동한다. etcd는 K8s 없이도 KV 저장소로 쓸 수 있고, K8s는 그 위에 얹힌 응용 프로그램이다.

### apiserver

etcd를 띄웠으니 etcd를 저장소로 사용하는 apiserver를 띄울 수 있다. K8s에서 일어나는 모든 변화는 apiserver를 거쳐 etcd에 저장되며 상태가 유지된다.

- kubectl이 Pod을 만들면 apiserver가 받아 etcd에 저장한다
- kubelet이 노드 status를 apiserver에 보고한다
- controller-manager가 Pod 부족을 감지하면 apiserver에 새 Pod 생성을 요청한다

api server에 요청이 들어오면 요청이 처리되는 과정을 6단계로 풀어볼 수 있다. 컨트롤 플레인 manifest에 적은 플래그 대부분이 이 6단계의 어느 단계를 어떻게 동작시킬지를 정한다.

- **Authentication** — 들어온 요청이 누구인지 식별하는 단계이다.별
  인증 수단이 여러 개 있고 [순서대로 시도한다](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/authentication/request/union/union.go). 각 수단은 별도 플래그로 켜고 끈다.
  - **client cert** (`--client-ca-file=ca.pem`): TLS handshake에서 받은 cert의 CN/O를 사용자/그룹으로 인식 (앞서 [Subject와 신원](#subject와-신원)에서 본 그 동작).
  - **service account 토큰** (`--service-account-key-file=...`, `--service-account-issuer=...`): Pod 안에서 들어온 요청의 `Authorization: Bearer ...` JWT를 [검증](https://github.com/kubernetes/kubernetes/tree/master/pkg/serviceaccount).
  - **bootstrap 토큰** (`--enable-bootstrap-token-auth=true`): 노드 합류용 단기 토큰. [구현](https://github.com/kubernetes/kubernetes/tree/master/staging/src/k8s.io/cluster-bootstrap/token).
  - **OIDC** (`--oidc-issuer-url`, `--oidc-client-id`): 외부 IdP 연동. [구현](https://github.com/kubernetes/kubernetes/tree/master/staging/src/k8s.io/apiserver/plugin/pkg/authenticator/token/oidc).

- **Authorization** (`--authorization-mode=Node,RBAC`): 식별된 신원이 이 요청을 할 권한이 있는지 검사하는 단계이다. 여러 authorizer를 체인으로 묶고 하나라도 허용하면 통과한다 ([union](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/authorization/union/union.go)).
  - [**Node Authorizer**](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/auth/authorizer/node): kubelet의 권한을 자기 노드 자원으로 좁힌다.
  - [**RBAC authorizer**](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/auth/authorizer/rbac): 그 외 일반 사용자/SA의 권한을 ClusterRole/RoleBinding으로 평가한다.

- **Mutating Admission** (`--enable-admission-plugins=...`): 객체를 etcd에 쓰기 전에 변형하는 단계이다.
  - 빌트인 예시
    - [`ServiceAccount` 어드미션](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/admission/serviceaccount): Pod에 SA 토큰 볼륨을 자동 마운트.
    - [`DefaultStorageClass`](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/admission/storage/storageclass/setdefault): PVC에 default StorageClass를 박는다.
  - 외부 webhook
    - [`MutatingWebhookConfiguration`](https://github.com/kubernetes/kubernetes/tree/master/staging/src/k8s.io/apiserver/pkg/admission/plugin/webhook/mutating)도 이 단계에 끼어든다. Istio 사이드카 주입이 대표적이다.

- **Validating Admission** (`--enable-admission-plugins`): 변형이 끝난 객체가 정책을 만족하는지 검사하는 단계이다.
  - 빌트인 예시
    - [`ResourceQuota`](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/admission/resourcequota), [`PodSecurity`](https://github.com/kubernetes/kubernetes/tree/master/staging/src/k8s.io/pod-security-admission) 등.
  - 외부 정책 엔진
    - [OPA Gatekeeper](https://open-policy-agent.github.io/gatekeeper/), [Kyverno](https://kyverno.io/)도 이 단계에 [webhook](https://github.com/kubernetes/kubernetes/tree/master/staging/src/k8s.io/apiserver/pkg/admission/plugin/webhook/validating)으로 들어간다.
  - 여기서 거부되면 etcd에 쓰지 않고 바로 4xx 응답이 나간다.

- **etcd write**: 직렬화한 객체를 etcd에 저장하는 단계이다.
  - 플래그: `--etcd-servers=...`, `--encryption-provider-config=...`
  - apiserver↔etcd mTLS: `--etcd-cafile`, `--etcd-certfile`, `--etcd-keyfile`
  - 이 단계 직전에 strategic merge patch / optimistic concurrency(`resourceVersion` 비교) 같은 충돌 처리가 들어간다.

- **Response** — 클라이언트에 결과를 반환하는 단계이다.
  - `kubectl create`가 끝나는 지점이 여기다.
  - 이 시점에 실제 컨테이너는 아직 떠 있지 않다. 컨테이너 생성은 controller/scheduler/kubelet이 watch로 받아 비동기로 처리한다.

#### watch와 list-watch

위 파이프라인은 한 번의 요청 흐름이고, apiserver의 또 다른 핵심 역할은 **watch 스트림 제공**이다. controller, scheduler, kubelet 모두 폴링하지 않고 watch로 이벤트를 받는다.

- 클라이언트는 처음 `LIST`로 현재 상태를 받고, 응답에 들어온 `resourceVersion`을 기록한다.
- 그다음 `WATCH ?resourceVersion=N`으로 그 시점 이후의 변경을 long-running HTTP 스트림으로 받는다.
- apiserver는 메모리에 [watch cache](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/storage/cacher/cacher.go)를 두고, etcd로부터 받은 변경을 watch 클라이언트들에게 fan-out한다. 같은 리소스에 watch가 100개 붙어 있어도 etcd엔 watch 하나만 연결된다.

`kubectl get pods --watch`나 controller 내부 informer 모두 이 메커니즘 위에서 돈다.

### controller-manager, scheduler

apiserver가 말 그대로 DB에 데이터를 저장해주는 API 인터페이스의 역할을 했다면, Pod가 부족하면 만들고, 노드가 죽으면 정리하는 등의 실제 의사결정은 api server가 아닌 다른 컴포넌트들이 수행한다. 보통 ~컨트롤러라는 이름이 붙는 것들이 그 목적의 컨테이너이다.

#### controller-manager

[controller-manager](https://github.com/kubernetes/kubernetes/tree/master/cmd/kube-controller-manager)는 여러 컨트롤러를 한 프로세스에 묶은 것이다. 들어 있는 컨트롤러 일부만 보면 이렇게 다양하다.

- **워크로드**: ReplicaSet, Deployment, StatefulSet, DaemonSet, Job, CronJob
- **서비스/네트워크**: Endpoint, EndpointSlice, Service Account
- **노드 관리**: Node controller (노드 죽으면 Pod 재배치 트리거), TTL controller
- **PV/PVC**: PersistentVolume binder, attach/detach
- **인증/권한**: ServiceAccount Token, CSR signer, RBAC bootstrap

각 컨트롤러는 동일한 패턴(reconcile loop)으로 돈다. 한 사이클은 다음과 같다.

- apiserver를 조회해서 현재 상태를 읽는다
- 사용자가 선언한 spec을 원하는 상태로 둔다
- 둘의 diff를 계산한다
- 그 diff만큼 apiserver에 변경 요청을 보낸다
- 잠시 대기하고 다음 사이클로

이게 K8s의 declarative + reconciliation 모델이다. 사용자가 원하는 상태를 선언하면 컨트롤러가 현재 상태를 그쪽으로 맞춘다.

실제 구현은 폴링 대신 **informer + work queue** 패턴을 쓴다. [informer](https://github.com/kubernetes/kubernetes/tree/master/staging/src/k8s.io/client-go/tools/cache)가 apiserver의 watch를 구독하다가 이벤트가 오면 객체 키(`<namespace>/<name>`)를 [work queue](https://github.com/kubernetes/kubernetes/tree/master/staging/src/k8s.io/client-go/util/workqueue)에 넣는다. worker 고루틴이 큐에서 키를 꺼내 reconcile 한다. 같은 키가 여러 번 들어와도 큐에서 dedup되므로 짧은 시간 안에 일어난 다수의 변경을 한 번의 reconcile로 흡수한다. 실패하면 exponential backoff로 재시도하는 것까지 client-go의 work queue가 표준화해 둔다.

코드 흐름은 대략 이렇게 생겼다

```go
// informer가 watch 이벤트를 받아 큐에 키를 넣는다
informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
    AddFunc:    func(obj interface{}) { c.enqueue(obj) },
    UpdateFunc: func(_, obj interface{}) { c.enqueue(obj) },
    DeleteFunc: func(obj interface{}) { c.enqueue(obj) },
})

func (c *Controller) enqueue(obj interface{}) {
    key, _ := cache.MetaNamespaceKeyFunc(obj) // "<namespace>/<name>"
    c.queue.Add(key)
}

// worker가 큐에서 키를 꺼내 reconcile 한다
func (c *Controller) processNextItem() bool {
    key, quit := c.queue.Get()
    if quit { return false }
    defer c.queue.Done(key)

    if err := c.syncHandler(key.(string)); err != nil {
        c.queue.AddRateLimited(key)  // 실패 시 backoff로 재큐
        return true
    }
    c.queue.Forget(key)              // 성공 시 backoff 카운터 초기화
    return true
}
```

실제 구현 예시: [ReplicaSet 컨트롤러](https://github.com/kubernetes/kubernetes/tree/master/pkg/controller/replicaset), [Deployment 컨트롤러](https://github.com/kubernetes/kubernetes/tree/master/pkg/controller/deployment), [Node 컨트롤러](https://github.com/kubernetes/kubernetes/tree/master/pkg/controller/nodelifecycle).

CRD에 컨트롤러를 붙이는 [Operator 패턴](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)도 결국 같은 informer+queue 메커니즘 위에서 돌아간다.

#### scheduler

Pod이 만들어졌는데 `nodeName`이 비어 있을 때(아직 띄울 노드가 정해지지 않았을 때) 어느 노드에 띄울지를 결정하는 것은 [scheduler](https://github.com/kubernetes/kubernetes/tree/master/pkg/scheduler)이다. 동작은 두 단계로 나뉜다.

- **Filter (predicate)**: 후보 노드 중에 이 Pod을 못 받는 노드를 걸러낸다. CPU/메모리가 모자라거나, NodeSelector가 안 맞거나, taint를 toleration이 못 받아내거나, 볼륨 zone이 안 맞으면 탈락.
- **Score (priority)**: 남은 노드들에 점수를 매겨 가장 적합한 한 곳을 고른다. 자원이 더 여유 있는 노드, 같은 Service의 다른 Pod이 분산된 노드, image가 이미 캐시된 노드 등이 가산점을 받는다.

위 두 단계는 [scheduler framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)([source](https://github.com/kubernetes/kubernetes/tree/master/pkg/scheduler/framework)) 위에 plugin으로 구현돼 있어, 사용자가 자체 plugin을 추가하거나 기본 plugin을 끌 수 있다. 빌트인 [기본 plugin들](https://github.com/kubernetes/kubernetes/tree/master/pkg/scheduler/framework/plugins) (`NodeResourcesFit`, `TaintToleration`, `InterPodAffinity` 등)이 Filter/Score를 제공한다.

[plugin이 만족해야 할 인터페이스](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/kube-scheduler/framework/interface.go)는 단순하다. Filter는 "이 노드 OK?"라는 boolean에 가까운 응답이고, Score는 정수 점수를 반환한다.

```go
// staging/src/k8s.io/kube-scheduler/framework/interface.go
type FilterPlugin interface {
    Plugin
    // 노드가 Pod에 적합하면 Success, 아니면 Unschedulable 등을 반환
    Filter(ctx context.Context, state CycleState,
           pod *v1.Pod, nodeInfo NodeInfo) *Status
}

type ScorePlugin interface {
    Plugin
    // 필터를 통과한 노드 각각에 정수 점수를 매긴다
    Score(ctx context.Context, state CycleState,
          p *v1.Pod, nodeInfo NodeInfo) (int64, *Status)
    ScoreExtensions() ScoreExtensions
}
```

결정이 나면 scheduler가 직접 Pod을 띄우지 않는다. apiserver에 "이 Pod의 `nodeName`을 w1으로 설정"하라는 요청만 보낸다(이걸 binding이라 부른다). 해당 노드의 kubelet이 watch하다 자기 노드에 할당된 Pod을 발견하면 실제 실행은 kubelet 쪽에서 한다.

#### leader election

cm와 scheduler 둘 다 leader election을 한다. cp 3대를 모두 띄워도 실제로 일하는 건 한 대고 나머지는 대기한다. 동일한 컨트롤러가 동시에 둘 도는 일을 막아야 하기 때문이다.

이를 어기면 발생하는 게 **split-brain**이다. 분산 시스템에서 리더가 한 명뿐이어야 하는데 여러 인스턴스가 자기가 리더인 줄 알고 동시에 일하는 상태를 가리킨다. 보통 다음 시나리오로 발생한다.

- cm A가 etcd에 lease를 갱신하던 중 네트워크가 잠시 끊긴다. A는 살아 있지만 갱신을 못 한다.
- cm B/C는 lease가 만료된 걸 본다. B가 재점유에 성공해 자기를 새 리더로 선언한다.
- 이 시점에 A는 자기가 여전히 리더인 줄 알고 reconcile loop를 돌린다.
- A와 B 둘 다 ReplicaSet을 보고 "Pod이 2개 부족"을 감지해 각자 2개씩 만든다. 결과적으로 4개가 떠버린다.
- 또는 같은 Service의 EndpointSlice를 동시에 갱신하다 서로의 변경을 덮어쓰며 endpoint가 깜빡인다.

요점은 "둘 다 살아 있는데 서로의 존재를 모른다"는 것이다. 이를 막는 가장 단순한 방법이 "갱신을 못 했으면 일단 죽어라"라는 규칙이고, K8s의 leader election이 정확히 이 규칙을 적용한다.

매커니즘은 K8s API 객체 [`Lease`](https://kubernetes.io/docs/concepts/architecture/leases/) 하나를 두고 그걸 갱신하는 것이다.

- 각 인스턴스가 `kube-system` 네임스페이스의 Lease 객체를 점유하려 시도한다 (`holderIdentity` 필드를 자기 ID로 쓴다).
- 점유에 성공한 인스턴스는 주기적으로 Lease의 `renewTime`을 갱신해 살아 있음을 알린다.
- 갱신이 끊기면 다른 인스턴스가 점유 시도를 한다.
- 갱신/획득에 실패하면 컨트롤러 루프를 즉시 종료한다. 살아 있는 줄 모르고 두 인스턴스가 동시에 동작하는 split-brain을 막기 위해서다.

cm/scheduler 모두 client-go의 [`leaderelection`](https://github.com/kubernetes/kubernetes/tree/master/staging/src/k8s.io/client-go/tools/leaderelection) 라이브러리를 그대로 쓴다. 사용 모양은 다음과 같다.

```go
// staging/src/k8s.io/client-go/tools/leaderelection/leaderelection.go
leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
    Lock: &resourcelock.LeaseLock{
        LeaseMeta: metav1.ObjectMeta{
            Namespace: "kube-system",
            Name:      "kube-controller-manager",
        },
        Client:     coordClient,
        LockConfig: resourcelock.ResourceLockConfig{Identity: hostname},
    },
    LeaseDuration: 15 * time.Second, // 이 시간 동안 갱신 없으면 다른 후보가 탈취 가능
    RenewDeadline: 10 * time.Second, // 리더가 갱신 시도하다 포기하는 시간
    RetryPeriod:   2 * time.Second,  // 후보가 점유 시도하는 주기
    Callbacks: leaderelection.LeaderCallbacks{
        OnStartedLeading: func(ctx context.Context) { runControllers(ctx) },
        OnStoppedLeading: func() { os.Exit(0) }, // 리더 자리를 잃으면 즉시 종료
    },
})
```

`OnStoppedLeading`에서 `os.Exit`을 부르는 게 split-brain 방지의 핵심이다. 갱신을 못 했다는 건 다른 인스턴스가 이미 리더로 일하고 있을 수 있다는 뜻이라, 자기는 깨끗이 죽는 게 안전하다.

### LB

cp가 3대일 때 워커가 어느 cp의 IP를 써야 할지 정해야 한다. 직접 cp IP를 쓰지 않고 LB의 IP를 사용한다. lb VM에 [HAProxy](https://www.haproxy.org/)를 띄워 6443 포트를 cp1/2/3로 분산한다.

```
frontend k8s_api
    bind *:6443
    default_backend k8s_api_servers

backend k8s_api_servers
    balance roundrobin
    option tcp-check
    server cp1 192.168.122.11:6443 check
    server cp2 192.168.122.12:6443 check
    server cp3 192.168.122.13:6443 check
```

여기선 `mode tcp` (L4 passthrough)를 쓴다. LB가 TLS를 풀지 않고 그대로 전달한다. LB는 TCP 라우터로만 동작하고 TLS 협상은 양 끝(client ↔ apiserver)에서 직접 한다.

`option tcp-check`로 백엔드 헬스 체크를 한다. 6443 포트가 TCP connect되면 살아 있다고 본다. apiserver가 죽거나 systemd unit이 죽으면 connect가 실패하고 HAProxy가 그 백엔드를 빼버린다.

[공식 권장](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/high-availability/)은 LB를 두는 쪽이다. 단, LB 1대면 그 자체가 SPOF가 되니 운영에선 보통 LB 2대를 [keepalived](https://www.keepalived.org/)로 묶어 VIP 하나를 active/standby로 공유한다. 클라이언트는 VIP만 알면 된다.

LB 없이 kubeconfig에 cp 3대 IP를 모두 적어 client-go가 차례로 시도하게 하는 방식도 있긴 하다. cert SAN에 모든 cp IP를 박아야 하고 클라이언트 라이브러리가 이 동작을 지원해야 해서 일반적이진 않다.

## Worker

컨트롤 플레인이 준비되었으니 워커 노드를 구성해보자. 워커 노드 위에 containerd, kubelet, kube-proxy를 띄우고, 그 전에 리눅스 호스트가 갖춰야 할 사전 조건도 같이 본다.

### Worker Node

컨테이너가 실제로 실행되는 곳이다. containerd, kubelet, kube-proxy가 함께 동작한다.

[**containerd**](https://containerd.io/)는 컨테이너 런타임이다. 이미지 풀과 컨테이너 라이프사이클 관리를 담당한다. namespace/cgroup으로 실제 격리를 만드는 일은 별도 데몬인 [**runc**](https://github.com/opencontainers/runc)에 위임한다. containerd는 [OCI](https://opencontainers.org/) 인터페이스로 runc를 호출한다.

**kubelet**은 K8s 노드 에이전트다. apiserver에 자기 노드를 등록하고, 자기 노드에 스케줄된 Pod 정보를 받아서 containerd에 "이 컨테이너 만들어줘" 요청한다.

containerd 호출은 [CRI](https://kubernetes.io/docs/concepts/architecture/cri/)(Container Runtime Interface)라는 gRPC 명세로 이루어진다. K8s가 컨테이너를 만드는 흐름은 다음과 같다.

- kubelet이 CRI gRPC로 containerd를 호출
- containerd가 OCI 인터페이스로 runc를 호출
- runc가 `clone`/`unshare`/`execve` syscall 호출
- 결과: namespace + cgroup으로 격리된 프로세스

3단 추상화 덕분에 컨테이너 런타임 교체가 쉽다 (containerd → [CRI-O](https://cri-o.io/) 등). kubelet은 CRI 인터페이스만 만족하면 어느 런타임이든 사용할 수 있다.

[**kube-proxy**](https://github.com/kubernetes/kubernetes/tree/master/pkg/proxy/iptables)는 데이터 흐름에 직접 관여하지 않는다. apiserver를 watch하면서 Service/Endpoint 변화를 감지하고, 노드의 iptables 룰을 갱신한다. 실제 패킷은 커널이 처리한다.

- Pod이 `10.32.0.5:80`(ClusterIP)으로 패킷을 보낸다
- 노드 iptables NAT가 미리 적어둔 룰에 따라 `10.200.0.7:8080`(실제 Pod IP)으로 DNAT
- L3 라우팅으로 목적지 Pod에 도착

kube-proxy가 만드는 iptables 룰을 `iptables-save -t nat`으로 보면 대충 아래같은 패턴이 반복된다

```bash
# 1. 모든 들어온 패킷이 KUBE-SERVICES를 거치게 한다
*nat
-A PREROUTING -j KUBE-SERVICES
-A OUTPUT     -j KUBE-SERVICES

# 2. ClusterIP:Port 매칭으로 서비스별 체인으로 분기
-A KUBE-SERVICES -d 10.32.0.5/32 -p tcp --dport 80 -j KUBE-SVC-NGINX

# 3. 서비스 체인이 백엔드 Pod 중 하나를 확률적으로 고른다 (간단한 random 부하분산)
-A KUBE-SVC-NGINX -m statistic --mode random --probability 0.50 -j KUBE-SEP-POD1
-A KUBE-SVC-NGINX -j KUBE-SEP-POD2

# 4. 엔드포인트 체인이 실제 DNAT을 수행해 Pod IP로 패킷을 돌린다
-A KUBE-SEP-POD1 -p tcp -j DNAT --to-destination 10.200.0.7:8080
-A KUBE-SEP-POD2 -p tcp -j DNAT --to-destination 10.200.1.5:8080
COMMIT
```

여기서 순서를 핵심적으로 봐야한다. `KUBE-SERVICES`는 모든 ClusterIP에 대한 매칭 룰이 들어 있는 디스패처고, `KUBE-SVC-XXX`는 백엔드 후보 중에서 하나를 고르는 분배기, `KUBE-SEP-XXX`는 실제 DNAT을 적용하는 종착 체인이다. Endpoint가 N개면 `KUBE-SVC` 체인에 N개의 분기 룰이 들어가고 마지막 한 개만 `--probability` 없이 fallback으로 박힌다.

kube-proxy 자체가 죽어도 기존 룰은 유지되어 ClusterIP가 잠시 작동한다. 다만 새 Pod 추가/삭제는 반영되지 않는다. 운영 환경에서 Service 수가 많아지면 iptables 룰 수가 선형으로 늘어나 갱신 비용이 커지는데, 이 문제 때문에 [IPVS 모드](https://github.com/kubernetes/kubernetes/tree/master/pkg/proxy/ipvs)나 [Cilium kube-proxy 대체](https://docs.cilium.io/en/stable/network/kubernetes/kubeproxy-free/)(eBPF) 같은 대안을 쓴다.

### 호스트 사전 준비

이제 kubelet을 시작하기 전에 리눅스 호스트에 다음 작업들을 해야 한다. 하나라도 빠지면 K8s가 시작을 거부하거나, 노드, pod간 통신 등 동작에 문제가 생길 수 있다.

- **커널 모듈 로딩** (`modprobe`)
  - `overlay`
    - 컨테이너 이미지의 layered filesystem을 지원하는 모듈이다.
    - 컨테이너 이미지는 read-only base layer 위에 변경사항을 별도 layer로 쌓는 구조다. 같은 base layer를 여러 컨테이너가 공유할 수 있어 디스크와 메모리가 절약된다.
    - containerd가 이미지 unpack 시 overlay를 사용하므로, 모듈이 없으면 컨테이너가 아예 안 뜬다.
  - `br_netfilter`
    - 리눅스 브리지를 통과하는 IP 패킷이 iptables/nftables 후킹을 거치게 해주는 모듈이다.
    - 기본 동작은 브리지의 L2 패킷이 L3 후킹을 우회하는데, 이 모듈을 올려야 그 우회를 풀 수 있다.
    - kube-proxy가 만든 NAT 룰이 브리지 통과 패킷에도 적용되려면 필수다.

- **sysctl 설정** (`/etc/sysctl.d/k8s.conf`에 박고 `sysctl --system`)
  - `net.bridge.bridge-nf-call-iptables=1`
    - 위 `br_netfilter` 모듈의 후킹을 실제로 켜는 스위치다.
    - 모듈만 올리고 이걸 안 켜면 후킹은 적용되지 않는다. 결과적으로 Pod이 Service ClusterIP에 보낸 패킷이 NAT되지 않고 그대로 브리지를 통과해, "왜 ClusterIP에 핑이 안 되지?" 같은 디버깅 지옥에 빠진다.
  - `net.bridge.bridge-nf-call-ip6tables=1`
    - IPv6도 사용한다면 같이 켠다. 같은 이유.
  - `net.ipv4.ip_forward=1`
    - 노드가 자기 NIC가 아닌 패킷을 다른 NIC로 forward(라우팅)하도록 허용한다.
    - The Hard Way에서는 cross-node Pod 통신을 노드의 정적 라우팅으로 처리하므로, 이게 꺼져 있으면 다른 노드 Pod으로 패킷이 안 나간다.

- **swap 비활성화**
  - kubelet은 `failSwapOn` 기본값이 true라 swap이 켜져 있으면 기동을 거부한다 (1.22부터 swap 지원이 베타로 들어왔지만 The Hard Way 기본 구성은 끄는 쪽이다).
  - 이유: K8s는 Pod에 메모리 limit을 걸고 그걸 넘기면 OOMKill로 정확히 끊는다. swap이 끼면 OS가 디스크로 떠넘기느라 limit 위반 감지와 격리가 흐려진다. "예측 가능한 메모리 격리"를 위해 swap을 빼는 게 K8s의 설계 결정이다.
  - 구체적으로는 `swapoff -a`와 `/etc/fstab`의 swap 라인 주석 처리.

- **cgroup driver 통일** (`systemd`)
  - cgroup driver는 cgroup 계층을 누가 관리하느냐를 정한다. 옵션은 `cgroupfs`(직접 `/sys/fs/cgroup` 조작)와 `systemd`(systemd가 cgroup 관리).
  - 호스트 init이 systemd인 환경에서는 systemd로 통일해야 한다. 안 그러면 같은 Pod의 cgroup을 systemd와 containerd가 서로 다른 경로에 만들어 두 개의 cgroup 트리가 생긴다.
  - 결과: 메모리/CPU limit이 한쪽에만 적용돼서 무력화되거나, OOM kill이 의도와 다른 프로세스를 죽인다.
  - 설정 위치 두 곳을 맞춰야 한다.
    - containerd: `/etc/containerd/config.toml`의 `[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]` 아래에 `SystemdCgroup = true`
    - kubelet: `--cgroup-driver=systemd` (또는 KubeletConfiguration의 `cgroupDriver: systemd`)

## Networking

워커 노드 위에 Pod이 뜨기 시작했으니 이제 Pod끼리 통신할 길이 필요하다. K8s 네트워킹은 Pod 직접 통신(L3 라우팅), Service 가상 IP(L4 NAT), 이름 해결(L7 DNS) 세 층으로 나뉘는데 이 절에서 차례대로 알아보자.

### Pod Network

K8s 네트워킹은 두 레이어로 나뉜다.

#### Pod IP 직접 통신 (L3 라우팅)

각 워커는 자기 Pod CIDR을 가진다.

- w1: `10.200.0.0/24`
- w2: `10.200.1.0/24`

같은 노드 안 Pod끼리는 브리지(`cnio0`)로 통신한다. 다른 노드 Pod과 통신은 노드를 라우터처럼 써서 정적 라우팅으로 처리한다.

```
w1: ip route add 10.200.1.0/24 via 192.168.122.22
w2: ip route add 10.200.0.0/24 via 192.168.122.21
```

CNI 솔루션([Flannel](https://github.com/flannel-io/flannel), [Calico](https://www.tigera.io/project-calico/), [Cilium](https://cilium.io/))을 쓰지 않는 The Hard Way 방식이다. 정적 라우트로 cross-node Pod 통신이 가능하다.

검증할 때 한 가지 확인할 점은 TTL이다. w1의 호스트에서 w2의 Pod IP로 ping을 보내면 TTL이 64에서 63으로 떨어진다. 정확히 1 hop을 거쳤다는 의미다.

#### Service ClusterIP (L4 NAT)

Service의 ClusterIP는 가상 IP다. 실제로는 어디에도 존재하지 않는다.

Pod이 Service ClusterIP에 패킷을 보내면 그 노드의 iptables NAT 룰이 가로채서 실제 Pod IP로 변환하고, 라우팅으로 전달한다. iptables NAT는 kube-proxy가 미리 적어둔 것이다.

이 두 레이어가 분리되어 있다는 건 운영 디버깅 시 중요하다. "Pod 간 ping 안 됨"은 L3 라우팅 문제이고, "Service IP 안 됨"은 L4 NAT 문제다. 어느 레이어 문제인지 구분하는 것이 디버깅의 출발점이다.

### CNI

위에서 각 노드의 cnio0 브리지에 Pod이 붙는다고 언급했는데, 실제로 이 작업을 하는 것이 CNI plugin이다.

[CNI](https://github.com/containernetworking/cni)(Container Network Interface)는 단순한 인터페이스다. stdin으로 JSON을 받고 stdout으로 JSON을 반환하는 실행 파일이면 충분하다. kubelet이 Pod을 만들 때 fork+exec로 호출한다.

Pod 시작 시 흐름은 다음과 같다.

1. kubelet이 containerd에 "Pod 만들어" (CRI gRPC)
2. containerd가 pause 컨테이너 생성 + network namespace 만듦
3. containerd가 `/opt/cni/bin/bridge` 실행
   - veth pair 생성
   - 한 끝을 Pod의 namespace에 넣음
   - 한 끝을 `cnio0` 브리지에 연결
   - host-local plugin 호출해서 Pod CIDR에서 IP 할당
   - Pod 안 `eth0`에 IP 박음
4. 결과 JSON 반환 → containerd → kubelet

CNI plugin은 거창한 시스템이 아니라 그냥 실행 파일이다. 100줄짜리 bash 스크립트로도 동작한다. 직접 짜보면서 살펴보자.

호출 측(containerd)은 환경 변수로 명령을 전달한다.

- `CNI_COMMAND`: `ADD`, `DEL`, `GET`, `VERSION` 중 하나
- `CNI_CONTAINERID`: 컨테이너 ID
- `CNI_NETNS`: 컨테이너 network namespace 경로 (예: `/proc/12345/ns/net`)
- `CNI_IFNAME`: 컨테이너 안에 만들 인터페이스 이름 (보통 `eth0`)

그리고 stdin으로 네트워크 설정 JSON이 들어온다. 결과는 stdout JSON으로 돌려줘야한다.

스크립트의 뼈대는 이렇다.

```bash
#!/bin/bash
set -e

config=$(cat /dev/stdin)
subnet=$(echo "$config" | jq -r '.subnet')   # 예: 10.200.0.0/24
gateway=$(echo "$config" | jq -r '.gateway') # 예: 10.200.0.1
bridge="cnio0"

case "$CNI_COMMAND" in
  ADD) cmd_add ;;
  DEL) cmd_del ;;
  VERSION) echo '{"cniVersion":"1.0.0","supportedVersions":["1.0.0"]}'; exit 0 ;;
esac
```

핵심은 `ADD`다. veth pair를 만들어 한쪽은 호스트 브리지에 붙이고, 다른 한쪽은 Pod의 network namespace로 넣은 뒤 IP를 부여한다.

```bash
cmd_add() {
  ip=$(allocate_ip "$subnet")              # 사용 가능한 IP 1개 할당
  host_veth="veth-${CNI_CONTAINERID:0:8}"  # 호스트 쪽 인터페이스 이름

  # veth pair 생성: 한쪽 $CNI_IFNAME, 다른쪽 $host_veth
  ip link add "$CNI_IFNAME" type veth peer name "$host_veth"

  # 호스트 쪽 끝을 브리지에 연결
  ip link set "$host_veth" master "$bridge" up

  # 컨테이너 쪽 끝을 Pod의 netns로 이동
  ip link set "$CNI_IFNAME" netns "$CNI_NETNS"

  # netns 안에서 IP/라우팅 설정
  ip -n "$CNI_NETNS" addr add "$ip/24" dev "$CNI_IFNAME"
  ip -n "$CNI_NETNS" link set "$CNI_IFNAME" up
  ip -n "$CNI_NETNS" route add default via "$gateway"

  # 결과 JSON을 stdout으로 반환
  cat <<EOF
{
  "cniVersion": "1.0.0",
  "ips": [{ "address": "$ip/24", "gateway": "$gateway" }]
}
EOF
}
```

`ip link`, `ip addr`, `ip route` 같은 평범한 리눅스 명령으로 컨테이너에 네트워크를 붙이는 게 전부다. CNI는 이 작업을 표준화한 인터페이스일 뿐이다.

`DEL`은 만든 걸 정리한다. veth는 한쪽만 지워도 pair가 같이 사라지므로 호스트 쪽 인터페이스만 지우면 된다.

```bash
cmd_del() {
  host_veth="veth-${CNI_CONTAINERID:0:8}"
  ip link del "$host_veth" 2>/dev/null || true
  release_ip "$CNI_CONTAINERID"
}
```

#### 원본 The Hard Way의 CNI 구성

원본 가이드는 직접 plugin을 짜지 않고 [containernetworking/plugins](https://github.com/containernetworking/plugins)의 레퍼런스 구현을 그대로 쓴다. 바이너리를 `/opt/cni/bin/`에 배포하고, 두 개의 설정 파일을 `/etc/cni/net.d/`에 둔다.

`10-bridge.conf`: 메인 네트워크. 노드별 Pod CIDR(`SUBNET`)이 들어간다.

```json
{
  "cniVersion": "1.0.0",
  "name": "bridge",
  "type": "bridge",
  "bridge": "cni0",
  "isGateway": true,
  "ipMasq": true,
  "ipam": {
    "type": "host-local",
    "ranges": [[{ "subnet": "SUBNET" }]],
    "routes": [{ "dst": "0.0.0.0/0" }]
  }
}
```

`99-loopback.conf`: Pod 안 `lo` 인터페이스를 살린다.

```json
{
  "cniVersion": "1.1.0",
  "name": "lo",
  "type": "loopback"
}
```

각 필드의 의미는 다음과 같다.

- `type: "bridge"`: `/opt/cni/bin/bridge` 바이너리를 호출한다 (위에서 직접 짠 일을 이 바이너리가 한다).
- `bridge: "cni0"`: Pod이 붙을 호스트 브리지 이름. 없으면 만든다.
- `isGateway: true`: 브리지에 게이트웨이 IP를 박는다. Pod의 default route가 향하는 곳이다.
- `ipMasq: true`: Pod CIDR 밖으로 나가는 패킷에 SNAT를 건다. 노드 IP로 가장하므로 외부와 통신할 수 있다.
- `ipam.type: "host-local"`: IPAM도 별도 plugin이다. `host-local`은 노드 디스크에 할당 상태를 저장하는 단순한 IP 할당기다. bridge가 host-local을 호출해 IP를 받아 Pod에 부여한다.
- `ipam.ranges`: 이 노드의 Pod CIDR. w1엔 `10.200.0.0/24`, w2엔 `10.200.1.0/24`처럼 노드마다 다르게 들어간다.

이 구성은 **노드 안 Pod 통신만** 책임진다. cross-node Pod 통신은 별도로 처리해야 하는데, Hightower 가이드는 [별도 챕터](https://github.com/kelseyhightower/kubernetes-the-hard-way/blob/master/docs/11-pod-network-routes.md)에서 노드 호스트의 라우팅 테이블에 정적 라우트를 박아 해결한다 (앞 절의 `ip route add 10.200.1.0/24 via 192.168.122.22`). Flannel이나 Calico를 쓰면 이 부분을 plugin이 자동으로 처리해 주는데, 그 자동화를 일부러 빼고 손으로 박아 동작 원리를 드러낸 것이 The Hard Way 방식이다.

운영 CNI 솔루션([Flannel](https://github.com/flannel-io/flannel)/[Calico](https://www.tigera.io/project-calico/)/[Cilium](https://cilium.io/))도 같은 메커니즘 위에 더 정교한 dataplane(eBPF, IPIP/VXLAN, BGP 라우팅 등)을 얹은 형태다.

### CoreDNS

지금까지는 IP만으로 통신이 가능한 상태다. 사용자가 이름으로 Service에 접근하려면 클러스터 내부 DNS가 필요하다. 이때 [CoreDNS](https://coredns.io/)가 사용된다. CoreDNS는 K8s 내부에서 Pod 형태로 동작하는 DNS 서버다. apiserver를 watch하며 Service 목록을 유지하다가 DNS 쿼리에 응답한다.

각 Pod의 `/etc/resolv.conf`에는 nameserver로 `10.32.0.10`(CoreDNS의 ClusterIP)이 적혀 있다. Pod이 DNS 쿼리를 보내면 다음 순서로 처리된다.

- Pod이 `10.32.0.10`으로 쿼리를 보낸다 (`/etc/resolv.conf`의 nameserver)
- 노드 iptables NAT가 실제 CoreDNS Pod IP(예: `10.200.0.5`)로 DNAT
- CoreDNS Pod이 apiserver를 watch하며 들고 있던 Service 목록에서 검색
- 매칭되는 ClusterIP를 A 레코드로 응답

CoreDNS의 동작은 ConfigMap 하나(`coredns` Corefile)로 정의된다. 기본값은 다음과 같다.

```
.:53 {
    errors
    health { lameduck 5s }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
       ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf { max_concurrent 1000 }
    cache 30
    loop
    reload
    loadbalance
}
```

각 directive가 plugin 하나에 해당한다. 핵심은 두 줄이다.

- `kubernetes cluster.local ...`: [CoreDNS의 kubernetes plugin](https://coredns.io/plugins/kubernetes/)이 apiserver를 watch해서 Service/Endpoint를 들고 있다가 `<service>.<ns>.svc.cluster.local` 쿼리에 ClusterIP를 응답한다.
- `forward . /etc/resolv.conf`: 클러스터 도메인이 아닌 쿼리는 호스트의 upstream resolver(예: `8.8.8.8`)로 위임한다.

`reload` 덕분에 Corefile을 수정하고 ConfigMap만 갱신해도 자동으로 다시 읽는다. `cache 30`은 30초 응답 캐시라 같은 Service 쿼리가 반복돼도 apiserver까지 가지 않는다.

한 번의 nslookup이 CNI 브리지, 라우팅, kube-proxy NAT, CoreDNS, apiserver의 Service watch, etcd를 모두 거친다. 클러스터 전체 동작을 한 번에 점검할 수 있는 경로다.

## Smoke Test

Hightower의 마지막 챕터는 smoke test다. 6개 시나리오로 클러스터의 동작을 확인한다.

1. **Data encryption**: Secret 객체가 etcd에 실제로 암호화되어 저장되는지 확인한다. etcdctl로 raw 값을 읽으면 `k8s:enc:aescbc:v1:key1:` 헤더 + 암호문이 보여야 한다. 평문이 보이면 암호화에 실패한 것이다.
2. **Deployment**: `kubectl create deployment nginx`로 Pod이 정상 작동하는지 확인한다.
3. **Logs**: `kubectl logs <pod>`. apiserver가 워커의 kubelet에 접속할 수 있어야 한다. apiserver→kubelet 호출을 위한 별도 RBAC 객체가 필요하다.
4. **Exec**: `kubectl exec <pod> -- nginx -v`. CRI를 통한 컨테이너 안 명령 실행을 확인한다.
5. **Port-forward**: `kubectl port-forward`. apiserver가 터널을 만들어 로컬 포트와 컨테이너 포트를 연결한다.
6. **NodePort Service**: 외부에서 노드 IP로 접근한다. iptables NAT가 트래픽을 Pod으로 전달한다.

6개가 모두 통과하면 K8s 클러스터로서 운영 가능한 상태가 된다.

## 정리

PKI, etcd, apiserver, kubelet, CNI, CoreDNS등 kubeadm init, join에 감춰진 것들을 하나씩 손으로 따라가보았다.

재밌는 경험이었다.

## 참고

- [Kubernetes The Hard Way](https://github.com/kelseyhightower/kubernetes-the-hard-way) — Kelsey Hightower

PKI / TLS / 인증

- [Kubernetes PKI Certificates and Requirements](https://kubernetes.io/docs/setup/best-practices/certificates/)
- [Kubernetes Authenticating](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)
- [Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Node Authorizer](https://kubernetes.io/docs/reference/access-authn-authz/node/)
- [Kubelet TLS Bootstrapping](https://kubernetes.io/docs/reference/access-authn-authz/kubelet-tls-bootstrapping/)
- [Certificate Signing Requests](https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/)
- [cfssl](https://github.com/cloudflare/cfssl) — Cloudflare PKI/TLS toolkit
- [RFC 5280 — X.509 v3 Certificate](https://www.rfc-editor.org/rfc/rfc5280)

컨트롤 플레인

- [kube-apiserver 플래그 레퍼런스](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/)
- [Static Pods](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
- [kubeadm](https://kubernetes.io/docs/reference/setup-tools/kubeadm/)
- [etcd](https://etcd.io/) / [Raft 논문](https://raft.github.io/)
- [Admission Controllers Reference](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- [OPA Gatekeeper](https://open-policy-agent.github.io/gatekeeper/) / [Kyverno](https://kyverno.io/)

컨테이너 런타임 / 노드

- [containerd](https://containerd.io/) / [CRI 스펙](https://kubernetes.io/docs/concepts/architecture/cri/)
- [runc](https://github.com/opencontainers/runc) / [OCI Runtime Spec](https://github.com/opencontainers/runtime-spec)
- [kubelet 레퍼런스](https://kubernetes.io/docs/reference/command-line-tools-reference/kubelet/)
- [Container Runtimes — cgroup drivers](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)

네트워크 / CNI

- [The Kubernetes Networking Guide](https://www.tkng.io/) — 네트워킹 깊은 곳
- [CNI 스펙](https://github.com/containernetworking/cni/blob/main/SPEC.md)
- [containernetworking/plugins](https://github.com/containernetworking/plugins) — bridge, host-local 등 reference 구현
- [Pod Network Routes (원본 가이드 챕터)](https://github.com/kelseyhightower/kubernetes-the-hard-way/blob/master/docs/11-pod-network-routes.md)
- [kube-proxy 동작 방식](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [CoreDNS](https://coredns.io/) / [Kubernetes DNS Specification](https://github.com/kubernetes/dns/blob/master/docs/specification.md)
- [Flannel](https://github.com/flannel-io/flannel) / [Calico](https://www.tigera.io/project-calico/) / [Cilium](https://cilium.io/)

리눅스 기반 (namespace, cgroup, 브리지)

- [`man 7 namespaces`](https://man7.org/linux/man-pages/man7/namespaces.7.html)
- [`man 7 cgroups`](https://man7.org/linux/man-pages/man7/cgroups.7.html)
- [`ip-link(8)`](https://man7.org/linux/man-pages/man8/ip-link.8.html), [`ip-netns(8)`](https://man7.org/linux/man-pages/man8/ip-netns.8.html)
- [`br_netfilter` 동작 설명](https://www.kernel.org/doc/Documentation/networking/bridge.txt)

소스 코드 참조

- [apiserver 인증 파이프라인](https://github.com/kubernetes/kubernetes/tree/master/staging/src/k8s.io/apiserver/pkg/authentication)
- [빌트인 ClusterRoleBinding](https://github.com/kubernetes/kubernetes/blob/master/plugin/pkg/auth/authorizer/rbac/bootstrappolicy/policy.go)
- [Node Authorizer 구현](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/auth/authorizer/node)
- [kubelet static pod manifest watcher](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/config/file.go)
- [kube-controller-manager](https://github.com/kubernetes/kubernetes/tree/master/cmd/kube-controller-manager) / [kube-scheduler](https://github.com/kubernetes/kubernetes/tree/master/pkg/scheduler)
