---
title: Kubernetes The Hard Way
lastUpdated: 2026-01-06T22:30:00
tags: ["Kubernetes", "리눅스", "PKI", "네트워크"]
---

[Kubernetes The Hard Way](https://github.com/kelseyhightower/kubernetes-the-hard-way) 가이드를 따라가며 k8s에 대해 깊게 이해해보자.

원본 가이드는 Debian 12 머신 4대(jumpbox 1, control plane 서버 1, worker 2)를 요구하고 가상화 방식은 자유이다. 본인은 api server, etcd HA를 테스트하기 위해 cp용 VM을 3대로 늘려 구성해볼 것이다. api server 용으로 LB도 한 대 둔다.

환경 구성은 ARM Ubuntu 24.04 Desktop에서 [KVM](https://www.linux-kvm.org/)/[libvirt](https://libvirt.org/) VM 6대를 만들고, 호스트 자체를 jumpbox로 사용해 진행했다. 워커는 처음 2대(`w1`, `w2`)를 가이드 방법대로 직접 셋업하고, 마지막에 3번째 워커 `w3`를 다른 방식(TLS bootstrap)으로 추가해 두 cert 발급 방식을 비교해볼 것이다.

가상머신별 구성 개요는 다음과 같다.

| 호스트 | IP             | 띄울 컴포넌트                   |
| ------ | -------------- | ------------------------------- |
| lb     | 192.168.122.10 | HAProxy (TCP passthrough :6443) |
| cp1    | 192.168.122.11 | etcd, apiserver, cm, scheduler  |
| cp2    | 192.168.122.12 | etcd, apiserver, cm, scheduler  |
| cp3    | 192.168.122.13 | etcd, apiserver, cm, scheduler  |
| w1     | 192.168.122.21 | containerd, kubelet, kube-proxy |
| w2     | 192.168.122.22 | containerd, kubelet, kube-proxy |
| w3     | 192.168.122.23 | (TLS bootstrap으로 추가)        |

## TLS & Certs

K8s는 모든 컴포넌트 간 통신에 mTLS를 쓰므로 cert와 그걸 서명할 CA부터 먼저 만들어야 한다.

### PKI

K8s의 모든 컴포넌트는 서로 통신할 때 mTLS로 양방향 인증을 한다. 총 두 개의 CA가 필요하다.

- **서버 검증용 CA**(`--tls-cert-file`): 의도한 서버에 요청한게 맞는지 검증할 CA. tls 인증서와 같은 방향
- **클라이언트 검증용 CA**(`--client-ca-file`): 서버가 서명해준 클라이언트인지 확인하기 위함, 즉 서명해준 클라이언트만 접속할 수 있도록

둘은 독립된 trust anchor라 다른 CA로 분리할 수 있다. 가이드에선 학습 편의상 자체 root CA 하나를 만들어 두 역할을 같이 맡긴다. cert 생성 도구로는 Cloudflare가 자체 PKI 운영을 위해 만든 [cfssl](https://github.com/cloudflare/cfssl)을 쓴다.

```bash
cfssl gencert -initca ca-csr.json | cfssljson -bare ca
```

이 한 줄로 root CA 인증서(`ca.pem`)와 개인 키(`ca-key.pem`)가 만들어진다. 이후 모든 cert는 이 CA로 서명한다. `ca-key.pem`이 유출되면 임의의 신원으로 cert를 위조할 수 있으니 보관에 주의해야한다.

**왜 공인 CA가 아니라 자체 CA를 쓸까**

- K8s는 cert의 `CN`을 사용자 이름, `O`를 그룹으로 해석한다. `O=system:masters` 같은 K8s 컨벤션 값을 넣으려면 발급자를 직접 통제해야 한다.
- 클러스터 내부에서만 검증되니 공개 신뢰 체계에 등록할 필요가 없다. 컴포넌트에서만 `ca.pem`을 가지고 있으면 된다.
- 만료/재발급/폐기를 직접 결정할 수 있고 외부 의존이 없다.
- 그리고 공인 CA는 애초에 `cp1`, `192.168.122.10` 같은 사설 호스트명/IP에 cert를 발급하지 않는다.

api cert를 자체 발급하므로, kubectl 등으로 api server에 요청하기 위해선 해당 CA의 공개키를 각 개발자가 로컬에 가지고 있어야한다.

공인 도메인이 있다면 두 CA 중 서버 검증용을 공인 CA로 분리하는 것도 가능은 하다. 클라이언트 검증은 그 CA가 서명한 모든 cert가 apiserver에 인증할 수 있도록 만드는 동작이기 때문에 공인 CA로 사용하면 안된다.

**왜 openssl이 아니라 cfssl를 쓸까**

- cert 요청을 JSON 파일로 정의하기 때문에 git으로 관리하고 재현하기 좋다.
- 명령이 한 줄로 끝난다. openssl처럼 대화형 입력이나 다단계 명령이 없다.
- 이 덕분에 여러 cert를 일괄 생성할 때 유리하다.

### Subject와 신원

X.509 인증서는 Subject라는 항목이 있다. Subject에는 6개 필드로 신원을 표현하는 값이 들어있다.

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

`O=system:masters`가 들어 있는 cert로 접속하면 `system:masters` 그룹으로 인식되고 cluster-admin 권한이 부여된다. [RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)을 명시적으로 설정하지 않아도 admin이 동작하는 이유다. K8s는 부팅 시 [빌트인 ClusterRoleBinding](https://github.com/kubernetes/kubernetes/blob/master/plugin/pkg/auth/authorizer/rbac/bootstrappolicy/policy.go) 50여 개를 etcd에 자동으로 등록하는데, `system:masters → cluster-admin`도 그 중 하나이다.

`O=system:nodes, CN=system:node:w1`이 들어 있는 cert로 접속하면 워커 w1의 신원으로 인식되고, [Node Authorizer](https://kubernetes.io/docs/reference/access-authn-authz/node/)([source](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/auth/authorizer/node))가 동작해 자기 노드의 자원만 접근하도록 제한한다.

결국 cert를 어떻게 만드는지가 권한 범위를 결정한다.

cfssl로 admin cert를 발급하는 예시는 다음과 같다.

```bash
# admin-csr.json
cat > admin-csr.json <<EOF
{
  "CN": "admin",
  "key": { "algo": "ecdsa", "size": 256 },
  "names": [{
    "C": "US", "L": "Portland", "ST": "Oregon",
    "O": "system:masters", "OU": "Kubernetes The Hard Way"
  }]
}
EOF

# CA로 서명
cfssl gencert \
  -ca=ca.pem -ca-key=ca-key.pem \
  -config=ca-config.json -profile=kubernetes \
  admin-csr.json | cfssljson -bare admin

# 결과 확인
openssl x509 -in admin.pem -noout -subject
# subject= /C=US/ST=Oregon/L=Portland/O=system:masters/OU=Kubernetes The Hard Way/CN=admin
```

다른 컴포넌트들도 같은 패턴이다. CSR JSON에 신원을 적고 cfssl로 CA가 서명한다.

### 컴포넌트별 cert

각 컴포넌트마다 신원이 다르므로 cert 데이터도 다르게 넣어준다.

| Cert                    | CN                             | O                   | 용도                     |
| ----------------------- | ------------------------------ | ------------------- | ------------------------ |
| admin                   | admin                          | system:masters      | kubectl 관리자           |
| w1                      | system:node:w1                 | system:nodes        | w1의 kubelet             |
| w2                      | system:node:w2                 | system:nodes        | w2의 kubelet             |
| kube-controller-manager | system:kube-controller-manager | system:nodes        | cm                       |
| kube-proxy              | system:kube-proxy              | system:node-proxier | kube-proxy               |
| kube-scheduler          | system:kube-scheduler          | system:node-proxier | scheduler                |
| kubernetes              | kubernetes                     | Kubernetes          | apiserver/etcd 서버 cert |
| service-account         | service-accounts               | Kubernetes          | SA 토큰 JWT 서명         |

### SAN

서버 cert에는 SAN(Subject Alternative Name)이라는 또 다른 항목을 사용한다.

```
X509v3 Subject Alternative Name:
    DNS: cp1, cp2, cp3, lb, kubernetes.default.svc.cluster.local
    IP:  127.0.0.1, 10.32.0.1, 192.168.122.11, 192.168.122.12, 192.168.122.13, 192.168.122.10
```

클라이언트가 `https://lb:6443`에 접속하면 TLS 핸드셰이크에서 cert의 SAN에 `lb`가 있는지 검사하기 때문이다. 없으면 `x509: certificate is valid for X, not lb` 에러로 실패한다.

이번에 생성하는 `kubernetes.pem`의 SAN에는 18개 항목이 들어간다. apiserver가 어떤 경로로 불리더라도 검증을 통과해야 하기 때문이다.

- `127.0.0.1`: apiserver 자기 자신의 health check
- `10.32.0.1`: Service CIDR 첫 IP. Pod 안에서 `kubernetes` Service에 붙을 때 사용된다
- `192.168.122.11/12/13`: cp 직접 IP
- `192.168.122.10`: lb. 워커가 LB 경유해서 부를 때 사용된다
- `cp1, cp2, cp3, lb`: 호스트명
- `kubernetes.default.svc.cluster.local`: Pod이 in-cluster DNS로 부를 때의 가장 긴 형태

CN은 cert의 신원을 표현하는 단일 값이고, SAN은 cert가 응답할 수 있는 호스트명/IP의 목록이라는 차이가 있다. 둘 다 들어 있는 cert는 클라이언트와 서버 양방향으로 작동한다.

cfssl에서 설정할 땐 `-hostname=...`로 SAN 목록을 넘기면 된다.

```bash
HOSTNAMES=10.32.0.1,127.0.0.1,\
192.168.122.11,192.168.122.12,192.168.122.13,192.168.122.10,\
cp1,cp2,cp3,lb,\
cp1.kubernetes.local,cp2.kubernetes.local,cp3.kubernetes.local,lb.kubernetes.local,\
kubernetes,kubernetes.default,kubernetes.default.svc,\
kubernetes.default.svc.cluster.local

cfssl gencert \
  -ca=ca.pem -ca-key=ca-key.pem \
  -config=ca-config.json -profile=kubernetes \
  -hostname="$HOSTNAMES" \
  kubernetes-csr.json | cfssljson -bare kubernetes

openssl x509 -in kubernetes.pem -noout -text | grep -A2 "Subject Alternative"
# DNS:cp1, DNS:cp2, ..., IP Address:10.32.0.1, IP Address:127.0.0.1, ...
```

### kubeconfig

컴포넌트가 api server에 요청하기 위해, 서버가 어디에 있는지, 누구로 인증할지 등 설정을 명시해주어야한다. 그 정보를 담는 파일이 kubeconfig다. YAML 파일로 구성된다.

`kubectl`도 같은 포맷의 파일을 사용하므로 kubeconfig를 경로에 복사해두면 그대로 동작한다. 클러스터 컴포넌트와 사용자는 api server에 접속하는 같은 입장이기 때문이다.

형식은 아래와 같다.

```yaml
clusters: # 어느 apiserver에 요청할지
  - name: my-cluster
    cluster:
      server: https://lb:6443
      certificate-authority-data: <base64 ca.pem>

users: # 누구로 인증할지
  - name: admin
    user:
      client-certificate-data: <base64 admin.pem>
      client-key-data: <base64 admin-key.pem>

contexts: # 위 두개가 context 설정으로 묶임
  - name: default
    context:
      cluster: my-cluster
      user: admin

current-context: default
```

이 파일은 `kubectl config` 명령으로 만들 수 있다.

```bash
KCFG=admin.kubeconfig

# 1. cluster 등록 (server URL + CA)
kubectl config set-cluster my-cluster \
  --certificate-authority=ca.pem --embed-certs=true \
  --server=https://127.0.0.1:6443 --kubeconfig=$KCFG

# 2. user 등록 (cert + key)
kubectl config set-credentials admin \
  --client-certificate=admin.pem --client-key=admin-key.pem \
  --embed-certs=true --kubeconfig=$KCFG

# 3. context 등록 (cluster × user)
kubectl config set-context default \
  --cluster=my-cluster --user=admin --kubeconfig=$KCFG

# 4. 기본 context 활성화
kubectl config use-context default --kubeconfig=$KCFG
```

`--embed-certs=true` 옵션이 없으면 기본값으로 cert 파일 경로만 파일에 포함한다. true를 주면 cert 내용이 base64로 통째로 삽입되어 사용할 수 있다.

6개 kubeconfig를 같은 패턴으로 만든다. 각 컴포넌트가 자기 cert로 자기 위치에서 클러스터에 접속하기 위한 설정이다. 컴포넌트마다 읽는 경로가 정해져 있다.

- kubelet → `/var/lib/kubelet/kubeconfig`
- kube-proxy → `/var/lib/kube-proxy/kubeconfig`
- controller-manager, scheduler, admin → `/etc/kubernetes/{controller-manager,scheduler,admin}.kubeconfig`

server URL은 컴포넌트가 어디서 도느냐에 따라 다르게 설정했다.

- 워커의 kubelet, kube-proxy는 `https://lb:6443`로 요청
  - cp 한 대가 죽어도 다른 cp로 넘어가야 하니 LB를 거친다.
- cp의 controller-manager, scheduler는 `https://127.0.0.1:6443`로 요청
  - 같은 노드에 apiserver가 떠 있으니 굳이 LB를 거칠 이유가 없다.

### TLS Bootstrap

여기까지는 jumpbox에서 cfssl로 발급한 cert(`CN=system:node:w1`, `O=system:nodes` 등)를 scp로 각 노드에 미리 배포해둔 상태를 만들었다. 만약 이 방법으로 노드를 더 추가한다면 똑같은 작업을 계속 반복해야 한다.

이를 해결하는 다른 방식은 [TLS bootstrap](https://kubernetes.io/docs/reference/access-authn-authz/kubelet-tls-bootstrapping/)이다. 새 노드가 단기 토큰으로 임시 인증을 통과한 뒤 자기 cert를 클러스터에 요청해 받아오는 방식이라, 노드를 동적으로 추가하는 상황에 유리하다. 흐름은 다음과 같다

1. 관리자가 `kubeadm token create`로 단기 bootstrap token을 만든다.
2. 새 노드의 kubelet이 이 토큰으로 apiserver에 인증한다
   - 이때의 신원은 `system:bootstrappers` 그룹이다
3. kubelet이 자기 노드의 신원(`CN=system:node:w3, O=system:nodes`)으로 [CSR](https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/)을 제출한다.
4. controller-manager의 CSR signer가 CSR을 [CA 개인키로 서명](https://github.com/kubernetes/kubernetes/tree/master/pkg/controller/certificates/signer)한다. RBAC 정책으로 `system:bootstrappers`가 제출한 노드 CSR은 자동 승인된다.
5. kubelet이 서명된 cert를 받아 이후 mTLS에 사용한다. bootstrap token은 만료되거나 폐기된다.

이 흐름이 동작하려면 controller-manager가 CA 개인키를 가지고 있어야 한다 (`--cluster-signing-cert-file=ca.pem`, `--cluster-signing-key-file=ca-key.pem`). 그리고 cert 만료 전 자동 rotate까지 같은 메커니즘으로 처리할 수 있게 된다. 우선 지금 방식으로 컨트롤 플레인과 워커 띄우는 방법을 본 후(w1, w2), 이후 단계에서 w3를 이 방식으로 연결해볼 것이다.

## Control Plane

인증 기반이 갖춰졌으니 컨트롤 플레인 컴포넌트를 차례로 띄워보자. 상태 저장소인 etcd로 시작해 apiserver, controller-manager, scheduler 순으로 올라가고, 마지막에 cp 3대 앞단의 LB를 둔다.

컨트롤 플레인 컴포넌트를 띄우는 방법은 호스트에서 바이너리를 직접 실행하거나, K8s가 관리하는 Pod으로 띄우는 방식 중에 선택할 수 있다. (여기선 전자의 방식을 사용한다)

k8s 공식 클러스터 부트스트랩 CLI 도구인 [kubeadm](https://kubernetes.io/docs/reference/setup-tools/kubeadm/)는 후자의 방식으로 컨트롤 플레인까지 Pod로 실행한다. K8s에는 로그 수집, 헬스 체크, 재시작, 롤링 업데이트 같은 매커니즘이 이미 갖춰져 있으니 컨트롤 플레인도 같은 방식으로 관리하면 운영 일관성을 지킬 수 있다.

그런데, 원래 Pod을 만들기 위해선 apiserver에 요청을 보내야 하는데, 띄우려는 Pod이 apiserver 자신이면 pod를 어떻게 실행할 수 있다는 말일까?

이럴 때 [**static pod**](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)를 사용하는 방법이 있다. kubelet은 평소엔 apiserver의 명령을 받아 Pod을 띄우지만, 동시에 `/etc/kubernetes/manifests` 디렉터리도 [watch](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/config/file.go)한다. 그 폴더에 yaml이 있으면 apiserver와 무관하게 그 yaml을 보고 직접 컨테이너를 띄운다.

apiserver, etcd, cm, scheduler manifest를 미리 깔아두면 kubelet이 이 4개를 static pod으로 띄운다. 일단 apiserver가 살아나면 이후 만들어지는 일반 워크로드 Pod은 apiserver, etcd write, kubelet를 거쳐 처리할 수 있게 된다.

static pod 경로인 `/etc/kubernetes/manifests/*`에 etcd, 넣으면 kubelet이 자동으로 mirror Pod을 만들어 apiserver에서 `kubectl get pods -n kube-system`으로 보이게 한다. 이 mirror Pod은 읽기 전용이라 apiserver에서 삭제해도 manifest를 안 지우면 다시 살아난다.

위 방법은 알아두도록 하자.

가이드에선 **컨트롤 플레인을 pod가 아닌 호스트의 systemd 데몬**으로 띄운다. 자기참조가 없으니 테스트 상황에서 고려할 것이 비교적 적어져, 이 글에서도 해당 방식을 따른다.

### etcd

K8s는 클러스터 상태(어떤 Pod이 어디 있고, 어떤 Service의 ClusterIP가 무엇인지 등)를 [etcd](https://etcd.io/)에 저장한다. 분산 KV 저장소를 cp1/cp2/cp3 3대로 띄우고, [raft](https://raft.github.io/) 합의 알고리즘으로 일관성을 유지하도록 할 것이다. 세 대를 띄우면 한 대가 죽어도 나머지 둘로 quorum이 유지되고, 두 대가 죽으면 read-only 상태가 된다.

etcd도 앞서 얘기한 것처럼 static pod로 생성하는 방법도 있지만, systemd unit으로 띄운다. 여기선 peer 주소를 고정으로 지정해준다. 동적으로 선택해야하는 경우 환경에 따라 SRV DNS, discovery service 등을 선택할 수 있겠다.

```bash
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

두 개 포트의 역할은 아래처럼 나뉜다.

- `2379`: 클라이언트(apiserver) 접속 포트. Get/Put/Watch 같은 KV 연산이 들어온다.
- `2380`: peer 포트. etcd 인스턴스끼리 raft 메시지(append entries, vote 등)를 주고받는다.

3대를 거의 동시에 시작해야 quorum이 형성된다. 한 대만 먼저 켜면 나머지 둘을 기다리다 timeout 될 수 있다.

```bash
# 호스트(jumpbox)에서 etcd 바이너리 받기
ETCD_VERSION=v3.5.16
curl -LO https://github.com/etcd-io/etcd/releases/download/${ETCD_VERSION}/etcd-${ETCD_VERSION}-linux-arm64.tar.gz
tar -xzf etcd-${ETCD_VERSION}-linux-arm64.tar.gz
cd etcd-${ETCD_VERSION}-linux-arm64

# 3대 cp에 바이너리 + cert 배포
for VM in cp1 cp2 cp3; do
  scp etcd etcdctl ubuntu@$VM:~/
  scp ca.pem kubernetes.pem kubernetes-key.pem ubuntu@$VM:~/
  ssh ubuntu@$VM '
    sudo install ~/etcd ~/etcdctl /usr/local/bin/
    sudo mkdir -p /etc/etcd /var/lib/etcd
    sudo chmod 700 /var/lib/etcd
    sudo mv ~/{ca,kubernetes,kubernetes-key}.pem /etc/etcd/
  '
done

# IP 치환한 systemd unit을 cp별로 배포 (생략)

# 3대 동시 시작 (병렬 ssh)
for VM in cp1 cp2 cp3; do
  ssh ubuntu@$VM 'sudo systemctl daemon-reload && sudo systemctl enable --now etcd' &
done
wait

# 검증
ETCDCTL_API=3 etcdctl member list \
  --endpoints=https://cp1:2379,https://cp2:2379,https://cp3:2379 \
  --cacert=ca.pem --cert=kubernetes.pem --key=kubernetes-key.pem
# 8d1709..., started, cp1, https://192.168.122.11:2380, https://192.168.122.11:2379, false
# 7ae912..., started, cp2, https://192.168.122.12:2380, https://192.168.122.12:2379, false
# 8aaed4..., started, cp3, https://192.168.122.13:2380, https://192.168.122.13:2379, false
```

3개 멤버가 모두 `started`로 보이면 정상이다.

K8s가 일반 RDB나 Redis를 쓰지 않고 etcd를 고른 이유는 두 가지 요구사항 때문이다.

- **선형화 가능한 읽기/쓰기** (linearizable read/write): 모든 컴포넌트가 같은 순서의 변경을 보지 못하면 컨트롤 플레인이 서로 다른 상태로 어긋난다. raft가 이를 보장한다.
- **변경 알림 (watch)**: K8s 컴포넌트는 폴링하지 않고 watch로 이벤트 스트림을 구독한다. apiserver가 받는 watch도 결국 etcd의 [MVCC](https://etcd.io/docs/latest/learning/data_model/) revision 기반 watch 위에서 돌아간다.

etcd는 KV 값을 revision으로 버전 관리할 수 있다. apiserver는 클라이언트가 `?resourceVersion=N`으로 watch를 시작하면 etcd에 그 revision부터 변경을 받아 흘려준다. 이 메커니즘 덕분에 controller-manager의 reconcile loop가 효율적으로 동작할 수 있다.

운영시에는 아래 두가지를 주의해야한다

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

provider 목록은 순서가 의미를 가진다. 쓸 때는 첫 번째 provider(aescbc)로 암호화하고, 읽을 때는 위에서부터 시도해 매칭되는 prefix로 복호화한다. 이 동작은 [K8s 공식 문서](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)에 명시돼 있고, 구현은 [`PrefixTransformers`](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/storage/value/transformer.go)의 `TransformToStorage`(쓰기는 첫 번째만)와 `TransformFromStorage`(읽기는 prefix 매칭)로 나뉘어 있다.

키 회전은 이 순서를 활용한다. 새 키를 첫 번째에 넣고 옛 키를 두 번째로 옮기면, 새로 쓰는 데이터는 자동으로 새 키로 암호화되고 옛 데이터는 두 번째 키로 계속 읽힌다. 한 번에 모든 Secret을 다시 쓸 필요도 없다. 첫 번째가 아닌 transformer로 복호화한 데이터는 *stale*로 마킹되어, 다음 update 시 자동으로 새 키로 재암호화된다.

### apiserver

etcd를 띄웠으니 etcd를 저장소로 사용하는 apiserver를 띄울 수 있다. K8s에서 일어나는 모든 변화는 apiserver를 거쳐 etcd에 저장되며 상태가 유지된다.

- kubectl이 Pod을 만들면 apiserver가 받아 etcd에 저장한다
- kubelet이 노드 status를 apiserver에 보고한다
- controller-manager가 Pod 부족을 감지하면 apiserver에 새 Pod 생성을 요청한다

api server에 요청이 들어오고 처리되는 과정을 6단계로 풀어볼 수 있다. 컨트롤 플레인 manifest에 적은 플래그 대부분이 이 과정과 연관되어있다.

- **Authentication**: 들어온 요청이 누구인지 식별하는 단계이다.
  인증 수단이 여러 개 있고 [순서대로 시도한다](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/authentication/request/union/union.go). 각 수단은 별도 플래그로 켜고 끈다.
  - **client cert** (`--client-ca-file=ca.pem`): TLS handshake에서 받은 cert의 CN/O를 사용자/그룹으로 인식 (앞서 [Subject와 신원](#subject와-신원)에서 본 그 동작).
  - **service account 토큰** (`--service-account-key-file=...`, `--service-account-issuer=...`): Pod 안에서 들어온 요청의 `Authorization: Bearer ...` JWT를 [검증](https://github.com/kubernetes/kubernetes/tree/master/pkg/serviceaccount)
  - **bootstrap 토큰** (`--enable-bootstrap-token-auth=true`): 노드 합류용 단기 토큰 [구현](https://github.com/kubernetes/kubernetes/tree/master/staging/src/k8s.io/cluster-bootstrap/token).
  - **OIDC** (`--oidc-issuer-url`, `--oidc-client-id`): 외부 IdP 연동 [구현](https://github.com/kubernetes/kubernetes/tree/master/staging/src/k8s.io/apiserver/plugin/pkg/authenticator/token/oidc).

- **Authorization** (`--authorization-mode=Node,RBAC`): 식별된 신원이 이 요청을 할 권한이 있는지 검사하는 단계이다. 여러 authorizer를 체인으로 묶고 하나라도 허용하면 통과한다 ([union](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/authorization/union/union.go)).
  - [**Node Authorizer**](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/auth/authorizer/node): kubelet의 권한을 자기 노드 자원으로 좁힌다.
  - [**RBAC authorizer**](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/auth/authorizer/rbac): 그 외 일반 사용자/SA의 권한을 ClusterRole/RoleBinding으로 평가한다.

- **Mutating Admission** (`--enable-admission-plugins=...`): 객체를 etcd에 쓰기 전에 변형하는 단계이다.
  - 예시
    - [`ServiceAccount` 어드미션](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/admission/serviceaccount): Pod에 SA 토큰 볼륨을 자동 마운트
    - [`DefaultStorageClass`](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/admission/storage/storageclass/setdefault): PVC에 default StorageClass를 넣어준다.
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
  - `--etcd-servers=https://127.0.0.1:2379`: kubeadm의 기본 동작에서 apiserver는 자기 노드의 etcd에만 붙는다.
  - 이 단계 직전에 strategic merge patch, optimistic concurrency(`resourceVersion` 비교) 같은 충돌 처리가 들어간다.

- **Response**: 클라이언트에 결과를 반환하는 단계이다.
  - 이 시점에 실제 컨테이너는 아직 떠 있지 않다. 컨테이너 생성은 controller, scheduler, kubelet이 watch로 받아 비동기로 처리한다.

이 파이프라인은 다음과 같이 직접 확인할 수 있다.

```bash
# 1. 인증 통과 + 가벼운 응답
kubectl get --raw=/healthz
# ok

# 2. 인증 + 인가 + etcd 읽기
kubectl get --raw=/api/v1/namespaces/default/pods
# {"kind":"PodList","apiVersion":"v1",...}

# 3. 인증 + 인가 + admission(MutatingWebhook 포함) + etcd 쓰기
kubectl create deployment nginx --image=nginx
# deployment.apps/nginx created

# 4. apiserver 자기 진단 (controller-manager / scheduler healthz도 같이 노출됨)
kubectl get componentstatuses
# NAME                 STATUS    MESSAGE
# controller-manager   Healthy   ok
# scheduler            Healthy   ok
# etcd-0               Healthy   ok
```

#### watch와 list-watch

위 파이프라인은 한 번의 요청 흐름이고, apiserver의 또 다른 핵심 역할은 **watch 스트림 제공**이다. controller, scheduler, kubelet 모두 폴링하지 않고 watch로 이벤트를 받는다.

- 클라이언트는 처음 `LIST`로 현재 상태를 받고, 응답에 들어온 `resourceVersion`을 기록한다.
- 그다음 `WATCH ?resourceVersion=N`으로 그 시점 이후의 변경을 long-running HTTP 스트림으로 받는다.
- apiserver는 메모리에 [watch cache](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/apiserver/pkg/storage/cacher/cacher.go)를 두고, etcd로부터 받은 변경을 watch 클라이언트들에게 fan-out한다. 같은 리소스에 watch가 100개 붙어 있어도 etcd엔 watch 하나만 연결된다.

`kubectl get pods --watch`나 controller 내부 informer 모두 이 메커니즘 위에서 돈다.

`-v=8` 옵션으로 kubectl이 실제로 보내는 HTTP 요청을 들여다볼 수 있다.

```bash
kubectl get pods --watch -v=8 2>&1 | head -20
# I... GET https://lb:6443/api/v1/namespaces/default/pods?limit=500
# I... GET https://lb:6443/api/v1/namespaces/default/pods?
#       allowWatchBookmarks=true&resourceVersion=12345&watch=true
```

첫 번째는 LIST(현재 상태와 `resourceVersion=N` 받기), 두 번째는 그 시점 이후의 변경을 받는 long-running watch 스트림. 새 Pod이 생기거나 사라질 때마다 같은 connection으로 이벤트가 흘러들어온다.

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

reconcile이 실제로 도는지 보려면 Pod을 하나 죽여보면 된다. ReplicaSet 컨트롤러가 즉시 재생성한다.

```bash
kubectl create deployment nginx --image=nginx --replicas=1
kubectl delete pod -l app=nginx
sleep 2
kubectl get pods -l app=nginx
# nginx-xxx-yyy   1/1   Running   0   2s   ← 새로 만들어짐
```

controller-manager 로그로 reconcile 흐름도 볼 수 있다.

```bash
ssh ubuntu@cp1 'sudo journalctl -u kube-controller-manager --since "1 min ago" | grep -i replicaset' | head
# I... "Updating status" controller="replicaset" ...
# I... "Too few replicas" need=1 creating=1 ...
```

#### scheduler

Pod이 만들어졌는데 `nodeName`이 비어 있을 때(아직 띄울 노드가 정해지지 않았을 때) 어느 노드에 띄울지를 결정하는 것은 [scheduler](https://github.com/kubernetes/kubernetes/tree/master/pkg/scheduler)이다. 동작은 두 단계로 나뉜다.

- **Filter (predicate)**: 후보 노드 중에 이 Pod을 못 받는 노드를 걸러낸다. CPU/메모리가 모자라거나, NodeSelector가 안 맞거나, taint를 toleration이 못 받아내거나, 볼륨 zone이 안 맞으면 탈락.
- **Score (priority)**: 남은 노드들에 점수를 매겨 가장 적합한 한 곳을 고른다. 자원이 더 여유 있는 노드, 같은 Service의 다른 Pod이 분산된 노드, image가 이미 캐시된 노드 등이 가산점을 받는다.

위 두 단계는 [scheduler framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)([source](https://github.com/kubernetes/kubernetes/tree/master/pkg/scheduler/framework)) 위에 plugin으로 구현돼 있어, 사용자가 자체 plugin을 추가하거나 기본 plugin을 끌 수 있다. 빌트인 [기본 plugin들](https://github.com/kubernetes/kubernetes/tree/master/pkg/scheduler/framework/plugins) (`NodeResourcesFit`, `TaintToleration`, `InterPodAffinity` 등)이 Filter/Score를 제공한다.

[plugin이 만족해야 할 인터페이스](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/kube-scheduler/framework/interface.go)는 단순하다. Filter는 노드가 괜찮은지 확인하는 boolean에 가까운 응답이고, Score는 정수 점수를 반환한다.

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

결정이 나면 scheduler는 apiserver에 '이 Pod의 `nodeName`을 w1으로 설정'하라는 요청만 보낸다(이걸 binding이라 부른다). 해당 노드의 kubelet이 watch하다 자기 노드에 할당된 Pod을 발견하면 실제 실행은 kubelet 쪽에서 한다.

이 흐름은 events에 그대로 찍힌다.

```bash
kubectl run test --image=nginx --restart=Never
kubectl get events --field-selector involvedObject.name=test
# REASON      OBJECT      MESSAGE
# Scheduled   pod/test    Successfully assigned default/test to w2  ← scheduler가 nodeName 결정
# Pulling     pod/test    Pulling image "nginx"                      ← 이때부턴 kubelet
# Pulled      pod/test    Successfully pulled image "nginx"
# Created     pod/test    Created container test
# Started     pod/test    Started container test
```

`Scheduled` 이벤트의 source가 `default-scheduler`다. 그 이후 단계는 모두 `kubelet`이 source. 의사결정과 실행이 분리되어 있다는 게 events 한 줄로 드러난다.

#### leader election

cm와 scheduler 둘 다 leader election을 한다. cp 3대를 모두 띄워도 실제로 일하는 건 한 대고 나머지는 대기한다. 동일한 컨트롤러가 동시에 둘 도는 일을 막아야 하기 때문이다. 문제 케이스는 보통 다음 시나리오로 발생한다.

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
        OnStoppedLeading: func() { os.Exit(0) }, // 리더 자리를 잃으면 즉시 종료
        OnStartedLeading: func(ctx context.Context) { runControllers(ctx) },
    },
})
```

`OnStoppedLeading`에서 `os.Exit`을 부르는 게 split-brain 방지의 핵심이다. 갱신을 못 했다는 건 다른 인스턴스가 이미 리더로 일하고 있을 수 있다는 뜻이라, 자기는 깨끗이 죽는 게 안전하다.

실제 lease 객체를 직접 들여다보면 누가 리더이고 언제 갱신했는지 그대로 보인다.

```bash
kubectl get lease -n kube-system kube-controller-manager -o yaml
# spec:
#   holderIdentity: cp1_a8f3...           ← 현재 리더 ID
#   leaseDurationSeconds: 15
#   acquireTime: "2026-05-03T13:20:01Z"
#   renewTime: "2026-05-03T15:42:18Z"     ← 마지막 갱신 시각
#   leaseTransitions: 0                   ← 그동안 리더 교체 횟수
```

cp1을 일부러 죽여보면 몇 초 뒤 `holderIdentity`가 cp2나 cp3로 바뀌고 `leaseTransitions`가 1 늘어나는 게 보인다.

#### 컨트롤 플레인 배포

apiserver, controller-manager, scheduler 세 바이너리를 cp1/2/3에 같이 깔고 systemd unit으로 띄운다. 각 컴포넌트의 systemd unit 작성은 이미 위에서 다뤘으니 여기선 배포 흐름만.

```bash
# 호스트에서 K8s 바이너리 받기
K8S_VERSION=v1.30.5
for f in kube-apiserver kube-controller-manager kube-scheduler kubectl; do
  curl -L -o $f https://dl.k8s.io/${K8S_VERSION}/bin/linux/arm64/$f
  chmod +x $f
done

# 3대 cp에 바이너리 + cert + kubeconfig + encryption-config 배포
for VM in cp1 cp2 cp3; do
  scp kube-apiserver kube-controller-manager kube-scheduler kubectl ubuntu@$VM:~/
  scp ca.pem ca-key.pem kubernetes.pem kubernetes-key.pem \
      service-account.pem service-account-key.pem ubuntu@$VM:~/
  scp encryption-config.yaml \
      kube-controller-manager.kubeconfig kube-scheduler.kubeconfig ubuntu@$VM:~/

  ssh ubuntu@$VM '
    sudo install ~/kube-apiserver ~/kube-controller-manager ~/kube-scheduler ~/kubectl /usr/local/bin/
    sudo mkdir -p /var/lib/kubernetes
    sudo mv ~/{ca,ca-key,kubernetes,kubernetes-key,service-account,service-account-key}.pem /var/lib/kubernetes/
    sudo mv ~/encryption-config.yaml ~/kube-controller-manager.kubeconfig ~/kube-scheduler.kubeconfig /var/lib/kubernetes/
    sudo chmod 600 /var/lib/kubernetes/*-key.pem /var/lib/kubernetes/encryption-config.yaml
  '
done

# IP 치환한 apiserver unit + 공통 cm/scheduler unit 배포 (생략)

# 3대 동시 시작
for VM in cp1 cp2 cp3; do
  ssh ubuntu@$VM '
    sudo systemctl daemon-reload
    sudo systemctl enable --now kube-apiserver kube-controller-manager kube-scheduler
  ' &
done
wait

# 검증
for VM in cp1 cp2 cp3; do
  echo "=== $VM ==="
  ssh ubuntu@$VM 'sudo systemctl is-active kube-apiserver kube-controller-manager kube-scheduler'
done
# active / active / active 로 떠야 정상
```

`ca-key.pem`도 cp 노드에 깔아둬야 한다. controller-manager가 [TLS Bootstrap에서 CSR을 서명](#tls-bootstrap)할 때 이 키가 필요하기 때문. CA 개인키가 jumpbox 밖으로 나가는 건 이때부터다.

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

```bash
# lb VM에 haproxy 설치 + 설정 배포
ssh ubuntu@lb 'sudo apt update && sudo apt install -y haproxy'
scp haproxy.cfg ubuntu@lb:~/
ssh ubuntu@lb '
  sudo mv ~/haproxy.cfg /etc/haproxy/haproxy.cfg
  sudo systemctl restart haproxy
  sudo systemctl enable haproxy
'

# 검증 — LB 통한 apiserver 호출
kubectl --kubeconfig=admin.kubeconfig --server=https://lb:6443 get --raw=/healthz
# ok
```

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

각 워커에서 한 번에 처리하는 셸은 다음과 같다.

```bash
# 커널 모듈 (재부팅 후에도 자동 로드)
sudo tee /etc/modules-load.d/k8s.conf > /dev/null <<EOF
overlay
br_netfilter
EOF
sudo modprobe overlay
sudo modprobe br_netfilter

# sysctl
sudo tee /etc/sysctl.d/k8s.conf > /dev/null <<EOF
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sudo sysctl --system

# swap 끄기 (즉시 + 영구)
sudo swapoff -a
sudo sed -i '/ swap / s/^\(.*\)$/#\1/g' /etc/fstab
```

### 워커 배포

호스트 사전 준비가 끝났으면 이제 바이너리를 깔고 systemd unit을 띄운다. containerd, runc, cni, crictl을 설치한다.

```bash
# 호스트(jumpbox)에서 워커 바이너리 받기
K8S_VERSION=v1.30.5
CONTAINERD_VERSION=v1.7.22
RUNC_VERSION=v1.1.13
CRICTL_VERSION=v1.30.0

# kubelet, kube-proxy
for f in kubelet kube-proxy; do
  curl -L -o $f https://dl.k8s.io/${K8S_VERSION}/bin/linux/arm64/$f
  chmod +x $f
done

# containerd (tarball 안에 containerd, containerd-shim-runc-v2, ctr 등 포함)
curl -LO https://github.com/containerd/containerd/releases/download/${CONTAINERD_VERSION}/containerd-${CONTAINERD_VERSION#v}-linux-arm64.tar.gz
tar -xzf containerd-*-linux-arm64.tar.gz

# runc
curl -L -o runc https://github.com/opencontainers/runc/releases/download/${RUNC_VERSION}/runc.arm64
chmod +x runc

# CNI plugins
curl -LO https://github.com/containernetworking/plugins/releases/download/${CNI_VERSION}/cni-plugins-linux-arm64-${CNI_VERSION}.tgz
mkdir -p cni-plugins && tar -xzf cni-plugins-linux-arm64-*.tgz -C cni-plugins

# crictl (CRI 디버깅 도구)
curl -LO https://github.com/kubernetes-sigs/cri-tools/releases/download/${CRICTL_VERSION}/crictl-${CRICTL_VERSION}-linux-arm64.tar.gz
tar -xzf crictl-*-linux-arm64.tar.gz
```

CNI plugin은 [위에서 작성한 bash 스크립트 두 개](#cni)를 그대로 쓴다. 별도 바이너리 다운로드 없이 `mybridge`, `myloopback` 두 파일이면 끝.

각 워커에 배포할 때 위치는 다음과 같이 정한다.

- `/usr/local/bin/`: 모든 바이너리 (`kubelet`, `kube-proxy`, `containerd`, `runc`, `crictl` 등)
- `/opt/cni/bin/`: CNI plugin 바이너리 (kubelet이 호출)
- `/etc/cni/net.d/`: CNI 설정 (`10-bridge.conf`, `99-loopback.conf`)
- `/etc/containerd/config.toml`: containerd 설정 (`SystemdCgroup = true` 박힌 것)
- `/var/lib/kubelet/`: kubelet 설정 + cert + kubeconfig
- `/var/lib/kube-proxy/`: kube-proxy 설정 + kubeconfig
- `/var/lib/kubernetes/ca.pem`: 양방향 TLS 검증용

```bash
# w1, w2에 배포 (POD_CIDR을 노드별로 다르게: w1=10.200.0.0/24, w2=10.200.1.0/24)
for VM in w1 w2; do
  case $VM in
    w1) POD_CIDR=10.200.0.0/24 ;;
    w2) POD_CIDR=10.200.1.0/24 ;;
  esac

  # 바이너리 묶어서 한 번에 보냄
  scp kubelet kube-proxy bin/containerd bin/containerd-shim-runc-v2 bin/ctr runc crictl ubuntu@$VM:~/

  # 우리가 만든 CNI plugin 두 개 + jq (스크립트 의존성)
  ssh ubuntu@$VM 'sudo apt install -y jq && sudo mkdir -p /opt/cni/bin'
  scp mybridge myloopback ubuntu@$VM:~/

  # cert + kubeconfig
  scp ca.pem ${VM}.pem ${VM}-key.pem ubuntu@$VM:~/
  scp ${VM}.kubeconfig ubuntu@$VM:~/kubelet-kubeconfig
  scp kube-proxy.kubeconfig ubuntu@$VM:~/kube-proxy-kubeconfig

  # config 파일들 (POD_CIDR과 HOSTNAME 치환된 것을 미리 만들어둠)
  scp containerd-config.toml 10-bridge-${VM}.conf 99-loopback.conf \
      kubelet-config-${VM}.yaml kube-proxy-config.yaml ubuntu@$VM:~/

  # systemd unit
  scp containerd.service kubelet.service kube-proxy.service ubuntu@$VM:~/

  ssh ubuntu@$VM "
    sudo install ~/kubelet ~/kube-proxy ~/containerd ~/containerd-shim-runc-v2 ~/ctr ~/runc ~/crictl /usr/local/bin/
    sudo install ~/mybridge ~/myloopback /opt/cni/bin/
    sudo mkdir -p /etc/containerd /etc/cni/net.d /var/lib/kubelet /var/lib/kube-proxy /var/lib/kubernetes
    sudo mv ~/containerd-config.toml /etc/containerd/config.toml
    sudo mv ~/10-bridge-${VM}.conf /etc/cni/net.d/10-bridge.conf
    sudo mv ~/99-loopback.conf /etc/cni/net.d/99-loopback.conf
    sudo mv ~/ca.pem /var/lib/kubernetes/
    sudo mv ~/${VM}.pem ~/${VM}-key.pem /var/lib/kubelet/
    sudo mv ~/kubelet-kubeconfig /var/lib/kubelet/kubeconfig
    sudo mv ~/kubelet-config-${VM}.yaml /var/lib/kubelet/kubelet-config.yaml
    sudo mv ~/kube-proxy-kubeconfig /var/lib/kube-proxy/kubeconfig
    sudo mv ~/kube-proxy-config.yaml /var/lib/kube-proxy/
    sudo mv ~/{containerd,kubelet,kube-proxy}.service /etc/systemd/system/
    sudo chmod 600 /var/lib/kubelet/*-key.pem
  "
done

# 시작 (containerd → kubelet → kube-proxy 순)
for VM in w1 w2; do
  ssh ubuntu@$VM '
    sudo systemctl daemon-reload
    sudo systemctl enable --now containerd kubelet kube-proxy
  ' &
done
wait

# 검증 — 노드가 등록됐는지
kubectl get nodes -o wide
# w1   Ready   <none>   30s   v1.30.5   192.168.122.21   ...   containerd://1.7.22
# w2   Ready   <none>   30s   v1.30.5   192.168.122.22   ...   containerd://1.7.22
```

`kubelet.service`의 `Requires=containerd.service`가 시작 순서를 보장한다. containerd가 죽으면 kubelet도 같이 정지된다. kube-proxy는 apiserver만 살아있으면 되니 별도 의존성 없음.

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

```bash
# 각 워커에 테스트 Pod을 띄우고
kubectl run pod-w1 --image=registry.k8s.io/pause:3.9 \
  --overrides='{"spec":{"nodeName":"w1"}}' --restart=Never
kubectl run pod-w2 --image=registry.k8s.io/pause:3.9 \
  --overrides='{"spec":{"nodeName":"w2"}}' --restart=Never

# 잠시 후 IP 확인
kubectl get pods -o wide
# pod-w1   1/1   Running   ...   10.200.0.2   w1
# pod-w2   1/1   Running   ...   10.200.1.2   w2

# w1 호스트에서 pod-w2로 ping → TTL 63
ssh ubuntu@w1 'ping -c2 10.200.1.2'
# 64 bytes from 10.200.1.2: icmp_seq=1 ttl=63 time=0.45 ms
```

#### Service ClusterIP (L4 NAT)

Service의 ClusterIP는 가상 IP이다. 실제로는 어디에도 존재하지 않는다.

Pod이 Service ClusterIP에 패킷을 보내면 그 노드의 iptables NAT 룰이 가로채서 실제 Pod IP로 변환하고, 라우팅으로 전달하는 구조로 동작한다. iptables NAT는 service 리소스 정의에 따라 kube-proxy가 미리 적어둔 것이다. (Service, Endpoint, Endpoint Slice)

만약 Pod 간 ping이 안된다면 L3 라우팅 문제이고, Service IP가 동작하지 않는다면 L4 NAT 문제이다.

### CNI

위에서 각 노드의 cnio0 브리지에 Pod이 붙는다고 언급했는데, 실제로 이 작업을 하는 것이 CNI plugin이다.

[CNI](https://github.com/containernetworking/cni)(Container Network Interface)는 단순한 인터페이스다. stdin으로 JSON을 받고 stdout으로 JSON을 반환하는 실행 파일이면 충분하다. kubelet이 Pod을 만들 때 fork+exec로 호출한다.

Pod 시작 시 흐름은 다음과 같다.

1. kubelet이 containerd에 Pod 만들라 지시 (CRI gRPC)
2. containerd가 pause 컨테이너 생성 + network namespace 생성
3. containerd가 `/opt/cni/bin/<plugin>` 실행 (conf의 `type` 값에 해당하는 실행 파일)
   - veth pair 생성
   - 한 끝을 Pod의 namespace에 넣음
   - 한 끝을 `cnio0` 브리지에 연결
   - Pod CIDR에서 IP 할당 (별도 IPAM plugin 호출 또는 자체 처리)
   - Pod 안 `eth0`에 IP 박음
4. 결과 JSON 반환 → containerd → kubelet

CNI의 역할은 큰 시스템이 아니라 단순한 네트워크 연결이다. 최소 스펙으론 100줄 내외의 bash 스크립트로도 동작하니, 직접 짜보면서 살펴보자.

호출 측(containerd)은 환경 변수로 명령을 전달한다.

- `CNI_COMMAND`: `ADD`, `DEL`, `GET`, `VERSION` 중 하나
- `CNI_CONTAINERID`: 컨테이너 ID
- `CNI_NETNS`: 컨테이너 network namespace 경로 (예: `/proc/12345/ns/net`)
- `CNI_IFNAME`: 컨테이너 안에 만들 인터페이스 이름 (보통 `eth0`)

그리고 stdin으로 네트워크 설정 JSON이 들어온다. 결과는 stdout JSON으로 돌려주어야한다. 외부 의존으로 파싱, 네트워크 설정을 위한 `jq`, `iproute2` 명령을 사용하면 본 로직은 100줄 내외로 구성할 수 있다.

```bash
#!/bin/bash
# /opt/cni/bin/mybridge — bridge + 단순 host-local IPAM 통합
set -e

CONF=$(cat)
SUBNET=$(echo "$CONF"  | jq -r '.subnet')          # 예: 10.200.0.0/24
GATEWAY=$(echo "$CONF" | jq -r '.gateway')         # 예: 10.200.0.1
BRIDGE=$(echo "$CONF"  | jq -r '.bridge // "cnio0"')

# 파일 기반 IPAM (할당 IP를 노드 디스크에 기록)
IPAM_DIR="/var/lib/cni/${SUBNET//\//_}"
mkdir -p "$IPAM_DIR"

allocate_ip() {
  local base; base=$(echo "$SUBNET" | sed 's|/.*||' | awk -F. '{print $1"."$2"."$3}')
  for i in $(seq 2 254); do
    [ -f "$IPAM_DIR/$base.$i" ] && continue
    echo "$CNI_CONTAINERID" > "$IPAM_DIR/$base.$i"
    echo "$base.$i"
    return
  done
  echo "subnet exhausted" >&2; exit 1
}

release_ip() {
  grep -lr "^$CNI_CONTAINERID$" "$IPAM_DIR" 2>/dev/null | xargs -r rm -f
}

cmd_add() {
  local ip; ip=$(allocate_ip)
  local host_veth="veth-${CNI_CONTAINERID:0:8}"

  # 브리지가 없으면 만들고 게이트웨이 IP 부여 + Pod CIDR SNAT 룰 등록
  ip link show "$BRIDGE" >/dev/null 2>&1 || {
    ip link add "$BRIDGE" type bridge
    ip addr add "$GATEWAY/24" dev "$BRIDGE"
    ip link set "$BRIDGE" up
    # ipMasq: Pod CIDR에서 브리지 밖으로 나가는 패킷에 SNAT (Pod → 외부 인터넷)
    iptables -t nat -C POSTROUTING -s "$SUBNET" ! -o "$BRIDGE" -j MASQUERADE 2>/dev/null \
      || iptables -t nat -A POSTROUTING -s "$SUBNET" ! -o "$BRIDGE" -j MASQUERADE
  }

  # veth pair: 한쪽은 host bridge, 다른쪽은 Pod netns
  ip link add "$CNI_IFNAME" type veth peer name "$host_veth"
  ip link set "$host_veth" master "$BRIDGE" up
  ip link set "$CNI_IFNAME" netns "$CNI_NETNS"

  # netns 안에서 IP/라우트
  ip -n "$CNI_NETNS" addr add "$ip/24" dev "$CNI_IFNAME"
  ip -n "$CNI_NETNS" link set "$CNI_IFNAME" up
  ip -n "$CNI_NETNS" route add default via "$GATEWAY"

  cat <<EOF
{"cniVersion":"1.0.0","ips":[{"address":"$ip/24","gateway":"$GATEWAY"}]}
EOF
}

cmd_del() {
  ip link del "veth-${CNI_CONTAINERID:0:8}" 2>/dev/null || true
  release_ip
}

case "$CNI_COMMAND" in
  ADD)     cmd_add ;;
  DEL)     cmd_del ;;
  VERSION) echo '{"cniVersion":"1.0.0","supportedVersions":["1.0.0"]}' ;;
esac
```

`ip link`, `ip addr`, `ip route` 같은 평범한 리눅스 명령으로 컨테이너에 네트워크를 붙이는 게 전부이다.veth는 한쪽만 지워도 pair가 같이 사라지므로 `cmd_del`은 호스트 쪽 인터페이스만 정리한다.

fresh netns의 loopback은 default가 DOWN 상태라, 기본 상태론 Pod 안에서 `127.0.0.1`을 사용하지 못하므로 `lo` 인터페이스도 추가해준다.

```bash
#!/bin/bash
# /opt/cni/bin/myloopback
[ "$CNI_COMMAND" = "ADD" ] && ip -n "$CNI_NETNS" link set lo up
echo '{"cniVersion":"1.0.0"}'
```

#### 워커에 배치

위 두 스크립트를 `/opt/cni/bin/`에 깔고, `/etc/cni/net.d/`에 conf 파일 두 개를 둔다.

`10-bridge.conf`: 노드별로 `SUBNET`이 다르게 들어간다 (w1=`10.200.0.0/24`, w2=`10.200.1.0/24`).

```json
{
  "cniVersion": "1.0.0",
  "name": "bridge",
  "type": "mybridge",
  "bridge": "cnio0",
  "subnet": "SUBNET",
  "gateway": "GATEWAY"
}
```

`99-loopback.conf`:

```json
{ "cniVersion": "1.0.0", "name": "lo", "type": "myloopback" }
```

`type` 값이 `/opt/cni/bin/` 안의 실행 파일 이름과 매칭된다. 여기선 `mybridge`, `myloopback`으로 우리 스크립트 이름을 그대로 사용하였다.

이 구성은 **노드 안 Pod 통신**(브리지)과 **외부 인터넷**(MASQUERADE)을 처리하고, cross-node Pod 통신은 [앞 절의 정적 라우팅](#pod-network)이 담당한다. 운영 환경에선 [Flannel](https://github.com/flannel-io/flannel), [Calico](https://www.tigera.io/project-calico/), [Cilium](https://cilium.io/) 같은 솔루션을 쓰는 게 정석이고, 이들도 결국 같은 CNI exec 인터페이스 위에 NetworkPolicy, encryption, eBPF dataplane 같은 더 정교한 기능을 얹은 형태다.

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

각 directive가 plugin 하나에 해당한다. 아래 두 줄이 중요하다.

- `kubernetes cluster.local ...`: [CoreDNS의 kubernetes plugin](https://coredns.io/plugins/kubernetes/)이 apiserver를 watch해서 Service/Endpoint를 들고 있다가 `<service>.<ns>.svc.cluster.local` 쿼리에 ClusterIP를 응답한다.
- `forward . /etc/resolv.conf`: 클러스터 도메인이 아닌 쿼리는 호스트의 upstream resolver(예: `8.8.8.8`)로 위임한다.

`reload` 덕분에 Corefile을 수정하고 ConfigMap만 갱신해도 자동으로 다시 읽는다. `cache 30`은 30초 응답 캐시라 같은 Service 쿼리가 반복돼도 apiserver까지 가지 않는다.

CoreDNS는 manifest 하나로 배포한다. ServiceAccount + ClusterRole + ClusterRoleBinding + ConfigMap(Corefile) + Deployment + Service(ClusterIP=10.32.0.10)가 한 파일에 들어 있다.

```bash
kubectl apply -f manifests/coredns.yaml

# Pod 정상 작동 확인
kubectl -n kube-system get pods -l k8s-app=kube-dns
# coredns-xxx   1/1   Running   0   30s
# coredns-yyy   1/1   Running   0   30s

# Service ClusterIP가 10.32.0.10인지 확인
kubectl -n kube-system get svc kube-dns
# kube-dns   ClusterIP   10.32.0.10   <none>   53/UDP,53/TCP   30s

# Pod 안에서 DNS 조회 (alpine은 nslookup이 정상 동작)
kubectl run dnstest --image=alpine:3 --restart=Never -- sleep 600
sleep 10
kubectl exec dnstest -- nslookup kubernetes.default.svc.cluster.local
# Server:   10.32.0.10
# Name:     kubernetes.default.svc.cluster.local
# Address:  10.32.0.1
```

한 번의 nslookup이 CNI 브리지, 라우팅, kube-proxy NAT, CoreDNS, apiserver의 Service watch, etcd를 모두 거친다. 클러스터 전체 동작을 한 번에 점검할 수 있는 경로다.

## TLS Bootstrap으로 노드 추가하기

워커의 네트워크까지 다 갖추었으니, 이제 앞서 언급한 TLS bootstrap 흐름대로 노드 `w3`를 추가해보자. 이번엔 cert를 미리 발급하지 않고 bootstrap token만으로 시작해 kubelet이 자신의 cert를 받아오게 할 것이다.

기존 워커들과의 설정 차이는 `/var/lib/kubelet/`에 cert를 미리 깔고, 대신 token이 박힌 bootstrap kubeconfig만 둔다는 점이다. 나머지(바이너리, ca.pem, kubelet config)는 동일하게 설정한다.

> 공개키인 ca.pem은 서버의 유효성을 검증하기 위해 가지고 있어야한다. 서명하는 비밀키는 api server만 가지고 있기 때문에 괜찮다.

> 여기서 쓰이는 token은 Pod이 쓰는 ServiceAccount 토큰과는 다르게 동작한다.
>
> 기본적으로 bootstrap token은 cert를 받기 전 잠깐 쓰는 임시 수단이기에 이후론 쓰이지 않는다. 그리고 ServiceAccount 토큰은 JWT인데 반해, bootstrap token은 그냥 `abcdef.0123456789abcdef` 같은 24자 평문이다. apiserver가 이 토큰을 받으면 etcd에서 같은 ID의 Secret을 찾아 token-secret 값과 일치하는지 단순 비교로 검증한다.

### 사전 준비

TLS Bootstrap을 활성화하려면 apiserver에 bootstrap token 옵션을 추가한 후 다시 시작해야한다.

```bash
for VM in cp1 cp2 cp3; do
  ssh ubuntu@$VM "
    sudo sed -i '/--allow-privileged=true/a\\  --enable-bootstrap-token-auth=true \\\\' /etc/systemd/system/kube-apiserver.service
    sudo systemctl daemon-reload
    sudo systemctl restart kube-apiserver
  "
done
```

그리고 서명 요청(CSR, Certificate Signing Requests)에 대한 권한을 `system:bootstrappers`와 `system:nodes`에 부여해준다.

```yaml
# manifests/tls-bootstrap-rbac.yaml
- kind: ClusterRoleBinding
  metadata: { name: kubelet-bootstrap }
  roleRef: { name: system:node-bootstrapper, ... }
  subjects: [{ kind: Group, name: system:bootstrappers }]

- kind: ClusterRoleBinding
  metadata: { name: node-autoapprove-bootstrap }
  roleRef:
    {
      name: system:certificates.k8s.io:certificatesigningrequests:nodeclient,
      ...,
    }
  subjects: [{ kind: Group, name: system:bootstrappers }]

- kind: ClusterRoleBinding
  metadata: { name: node-autoapprove-certificate-rotation }
  roleRef:
    {
      name: system:certificates.k8s.io:certificatesigningrequests:selfnodeclient,
      ...,
    }
  subjects: [{ kind: Group, name: system:nodes }]
```

```bash
kubectl apply -f manifests/tls-bootstrap-rbac.yaml
```

각 권한이 노드 라이프사이클의 세 시점을 각각 담당한다.

- `kubelet-bootstrap`: 토큰으로 들어온 노드(`system:bootstrappers`)에게 CSR을 제출할 권한을 부여한다.
- `node-autoapprove-bootstrap`: bootstrappers의 노드용 CSR을 자동 승인 대상으로 표시한다. controller-manager의 csrapproving controller가 이 표식이 붙은 CSR을 사람 손 없이 통과시킨다.
- `node-autoapprove-certificate-rotation`: 등록된 노드의 cert 갱신 CSR도 같은 방식으로 자동 승인. 이때 신원은 토큰이 아니라 자기 cert 기반이라 그룹이 `system:bootstrappers`가 아닌 `system:nodes`다.

하나라도 빠지면 어딘가에서 사람이 끼어야 한다. 첫째가 빠지면 노드 합류 자체가 막히고, 둘째가 빠지면 노드 추가 때마다, 셋째가 빠지면 cert 갱신 때마다 손으로 승인해야 한다.

### Bootstrap token 생성

token은 `kube-system` namespace의 Secret 형태로 만든다. apiserver가 자동으로 인식한다.

```bash
TOKEN_ID=$(openssl rand -hex 3)
TOKEN_SECRET=$(openssl rand -hex 8)

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: bootstrap-token-${TOKEN_ID}
  namespace: kube-system
type: bootstrap.kubernetes.io/token
stringData:
  token-id: "${TOKEN_ID}"
  token-secret: "${TOKEN_SECRET}"
  expiration: "$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)"
  usage-bootstrap-authentication: "true"
EOF
```

토큰 형식은 `<ID>.<Secret>`이다. apiserver가 토큰을 받으면 ID로 Secret을 찾고, Secret 값과 일치하면 인증을 통과시킨다. 인증된 신원은 username `system:bootstrap:<token-id>` + group `system:bootstrappers`를 자동으로 부여받는다.

> 주의할 점은, `auth-extra-groups` 필드를 추가하려면 값이 반드시 `system:bootstrappers:<suffix>` 형식이어야 한다. 추가 그룹에 대해서만 해당하는 정규식 검증(`\Asystem:bootstrappers:[a-z0-9:-]{0,255}[a-z0-9]\z`)이 들어있기 때문이다.

### Bootstrap kubeconfig

기존 kubeconfig에서 cert를 넣는 대신, bootstrap kubeconfig은 token을 넣어준다. cluster/context 설정은 이전 부분에 했던것과 동일하다.

```bash
kubectl config set-credentials kubelet-bootstrap \
  --token=${TOKEN_ID}.${TOKEN_SECRET} --kubeconfig=$KCFG
```

### kubelet 설정 변경

systemd unit에 두 플래그를 추가한다.

```
--bootstrap-kubeconfig=/var/lib/kubelet/bootstrap-kubeconfig
--cert-dir=/var/lib/kubelet/pki
```

`--bootstrap-kubeconfig`은 cert가 없을 때 사용할 임시 kubeconfig이고, `--cert-dir`은 받은 cert가 저장될 위치다. kubelet이 부팅하면 bootstrap kubeconfig으로 시작해 cert를 받고, 받은 cert로 정식 kubeconfig을 만들어 그 쪽으로 전환하게 된다.

KubeletConfiguration에 두 줄도 추가한다.

```yaml
serverTLSBootstrap: true # serving cert도 bootstrap으로 받음
rotateCertificates: true # 자동 갱신 활성화
```

### CSR 흐름 관찰

준비가 끝나고 w3에서 kubelet을 시작하기 전, 호스트에서 CSR watch를 띄워둔다.

```bash
# 터미널 A
kubectl get csr -w
```

다른 터미널에서 w3의 kubelet을 시작한다.

```bash
# 터미널 B
ssh ubuntu@w3 'sudo systemctl enable --now containerd kubelet kube-proxy'
```

터미널 A에서 CSR 두 개가 차례로 등장한다.

```
NAME      AGE   SIGNERNAME                                    REQUESTOR                 ...
csr-xxx   0s    kubernetes.io/kube-apiserver-client-kubelet   system:bootstrap:abcdef   Pending
csr-xxx   1s    kubernetes.io/kube-apiserver-client-kubelet   system:bootstrap:abcdef   Approved,Issued
csr-yyy   5s    kubernetes.io/kubelet-serving                 system:node:w3            Pending
csr-yyy   6s    kubernetes.io/kubelet-serving                 system:node:w3            Approved,Issued
```

두 단계가 순서대로 일어난다.

- **첫 CSR**: `system:bootstrap:abcdef`(token 신원)이 client cert(`CN=system:node:w3`)를 요청한다. `node-autoapprove-bootstrap` RBAC이 자동 승인한다.
- **두 번째 CSR**: 받은 client cert로 다시 인증한 kubelet이 자기 serving cert(kubelet 자체의 HTTPS 서버용)를 요청한다. `node-autoapprove-certificate-rotation` RBAC이 자동 승인한다. `serverTLSBootstrap: true` 설정 덕분에 이 단계가 추가로 일어난다.

### 검증

```bash
kubectl get nodes
# w3가 Ready로 등장

ssh ubuntu@w3 'sudo ls /var/lib/kubelet/pki/'
# kubelet-client-current.pem -> kubelet-client-2026-...-pem
# kubelet-server-current.pem -> kubelet-server-2026-...-pem

ssh ubuntu@w3 'sudo openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -subject'
# subject= /O=system:nodes/CN=system:node:w3
```

기존 워커들과 동일한 신원(`system:node:w3`, `system:nodes` 그룹)이지만 발급 경로가 다르다. cfssl로 jumpbox에서 만든 게 아니라, kubelet이 CSR로 요청해 controller-manager가 ca-key.pem으로 서명한 것이다.

이 로직을 코드화한다면 TLS Bootstrap에는 사람의 개입이 없어도 된다. kubeadm join 명령도 이와 동일한 절차를 거친다.

## Test

### Smoke Test

마지막 챕터는 smoke test다. 6개 시나리오로 클러스터의 동작을 확인한다.

**1. Data encryption**: Secret 객체가 etcd에 실제로 암호화되어 저장되는지 확인한다.

```bash
kubectl create secret generic kubernetes-the-hard-way \
  --from-literal="mykey=mydata"

# etcd raw 값을 직접 읽어본다
ETCDCTL_API=3 etcdctl get \
  --endpoints=https://cp1:2379 \
  --cacert=ca.pem --cert=kubernetes.pem --key=kubernetes-key.pem \
  /registry/secrets/default/kubernetes-the-hard-way | hexdump -C | head
# 00000030  79 0a 6b 38 73 3a 65 6e  63 3a 61 65 73 63 62 63  |y.k8s:enc:aescbc|
# 00000040  3a 76 31 3a 6b 65 79 31  3a 6a 03 2f c2 20 b5 9e  |:v1:key1:j./. ..|
```

`k8s:enc:aescbc:v1:key1:` 헤더와 그 뒤 random 바이트가 보이면 정상이다. 평문 `mydata`가 보이면 `EncryptionConfiguration`이 동작하지 않은 것이다.

**2. Deployment**: `kubectl create deployment`로 Pod이 정상 작동하는지 확인한다.

```bash
kubectl create deployment nginx --image=nginx:1.27 --replicas=1
kubectl get pods -o wide
# nginx-xxx   1/1   Running   0   30s   10.200.0.5   w1
```

**3. Logs**: `kubectl logs`. apiserver가 워커의 kubelet에 접속할 수 있어야 한다. apiserver→kubelet 호출을 위한 별도 RBAC 객체가 필요하다.

```bash
POD=$(kubectl get pod -l app=nginx -o jsonpath='{.items[0].metadata.name}')
kubectl logs $POD | head
```

**4. Exec**: CRI를 통한 컨테이너 안 명령 실행

```bash
kubectl exec $POD -- nginx -v
# nginx version: nginx/1.27.5
```

**5. Port-forward**: apiserver가 터널을 만들어 로컬 포트와 컨테이너 포트를 연결한다.

```bash
kubectl port-forward $POD 18080:80 &
curl -s http://localhost:18080 | head
# <!DOCTYPE html>
# <html>
# <head>
# <title>Welcome to nginx!</title>
```

**6. NodePort Service**: 외부에서 노드 IP로 접근한다. Pod이 w1에만 있어도 w2의 IP로 접근 가능해야 한다 (iptables NAT가 트래픽을 Pod으로 전달)

```bash
kubectl expose deployment nginx --port=80 --type=NodePort
NODE_PORT=$(kubectl get svc nginx -o jsonpath='{.spec.ports[0].nodePort}')

curl -s http://192.168.122.21:$NODE_PORT | head -3   # w1
curl -s http://192.168.122.22:$NODE_PORT | head -3   # w2 (Pod 없는 노드)
# <!DOCTYPE html>
# <html>
# <head>
```

6개가 모두 통과하면 K8s 클러스터로서 운영 가능한 상태가 된다.

### Failover Test

cp 3대 + LB 구성이라 HA가 실제로 작동하는지 직접 깨뜨려 확인할 수 있다. apiserver와 etcd는 HA 메커니즘이 다르니 따로 본다.

#### apiserver HA

api server는 stateless이다. 상태는 DB인 etcd가 가지고 있고, api server는 그걸 받아 REST로 노출할 뿐이다. 그래서 N대 중 1대만 살아있어도 기능적으론 멀쩡하다. api server 하나를 꺼도 LB가 제대로 동작하면 조회하는 입장에선 문제가 발생하지 않는다.

cp2를 통째로 셧다운해서 apiserver, cm, scheduler가 한꺼번에 사라지는 상황을 만들어보자.

```bash
ssh ubuntu@cp2 'sudo poweroff' &
```

15초 안에 정상 복구되었다.

```
cp2 down
kube-controller-manager: cp2 → cp1
kube-scheduler:           cp2 → cp1
kubectl get nodes:        timeout 없이 즉시 응답
```

이 사이에 두 가지가 동시에 일어났다.

- **HAProxy의 health check** (`check inter 5s, fall 3` → 15초)가 cp2를 backend pool에서 빼고
- **lease 갱신**(`leaseDuration 15s, renewDeadline 10s`)이 끊겨 cm/scheduler가 자살하고 cp1/cp3가 새 leader 선거

apiserver 2대를 동시에 잃어도 동작은 같다. 살아있는 1대로 모든 트래픽이 몰릴 뿐 기능엔 영향이 없다. apiserver의 HA는 quorum 같은 합의 메커니즘이 아니라 단순한 fan-out이기 때문이다.

#### etcd HA

etcd는 stateful이고 raft 합의로 일관성을 유지한다. quorum(N/2+1)이 깨지면 read/write 모두 막힌다. 총 갯수가 3대라면 2대까지 살아있어야 한다.

위 시나리오에서 cp2 셧다운으로 etcd 1대도 같이 사라졌는데, quorum(2/3)은 유지되어 새 leader가 선출되었다.

```
etcd leader: cp2 → cp1 (RAFT TERM 4 → 5)
```

term이 +1 된 것을 보면 새 election이 일어났다는걸 알 수 있다.

이번엔 etcd 두 대를 동시에 멈춰서 quorum을 일부러 깨뜨려보자. apiserver, cm, scheduler는 살려둔다.

```bash
ssh ubuntu@cp1 'sudo systemctl stop etcd' &
ssh ubuntu@cp2 'sudo systemctl stop etcd' &
wait
```

```bash
$ kubectl get nodes
Error from server: etcdserver: request timed out

$ kubectl create namespace failover-test
# 10초 timeout 후 종료
```

apiserver 자체는 살아있고 요청을 받지만, 모든 etcd 호출이 timeout이라 응답을 만들지 못한다. read도 막힌 이유는 살아있는 cp3의 etcd 로그에 나온다.

```
"agreement among raft nodes before linearized reading" (duration: 9.999s)
"became pre-candidate at term 6"
"sent MsgPreVote request to cp1, cp2"
```

etcd의 read는 기본적으로 linearized read(가장 최신 합의된 값을 읽음 보장)라 raft agreement가 필요하다. cp3 혼자선 quorum이 없어 agreement가 안 잡히고, 새 leader 선거(`pre-candidate`)도 다른 멤버 응답이 없어 실패하여 결과적으로 read도 timeout이 되었다.

대신 이미 떠 있는 워크로드는 계속 작동했다. kubelet은 자기 컨테이너를 watch하고 컨테이너 런타임은 독립적이라, control plane이 멈춰도 기존 Pod의 트래픽 처리는 영향이 없다. cp1, cp2의 etcd를 다시 시작하면 10초 안에 quorum이 다시 형성되고 kubectl이 즉시 회복한다. RAFT TERM은 5 → 7로 두 단계 바뀌었다 (깨진 동안 cp3가 실패한 election + 회복 후 새 election).

## 정리

[Kubernetes The Hard Way](https://github.com/kelseyhightower/kubernetes-the-hard-way)를 따라 Kubernetes 클러스터를 직접 구성하면서 apiserver, etcd, controller, kubelet로 이어지는 흐름과 TLS 기반 인증, watch 기반 동작, 그리고 라우팅, NAT, DNS로 구성된 네트워크 구조를 확인했다.

가이드를 따라가는 중 궁금한 부분은 더 자세히 파보고 일부는 직접 구현해보면서 동작을 검증하려 했고, control plane과 etcd의 HA 구성, TLS bootstrap을 통한 노드 추가까지 실습해보며 Kubernetes의 기본 구성 동작들을 더 깊게 이해할 수 있었다.

이것저것 하느라 조금 난잡해진 것 같기도 하지만 재밌는 경험이었다.

## 참고

- [Kubernetes The Hard Way](https://github.com/kelseyhightower/kubernetes-the-hard-way) by Kelsey Hightower

PKI, TLS, Auth

- [Kubernetes PKI Certificates and Requirements](https://kubernetes.io/docs/setup/best-practices/certificates/)
- [Kubernetes Authenticating](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)
- [Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Node Authorizer](https://kubernetes.io/docs/reference/access-authn-authz/node/)
- [Kubelet TLS Bootstrapping](https://kubernetes.io/docs/reference/access-authn-authz/kubelet-tls-bootstrapping/)
- [Certificate Signing Requests](https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/)
- [cfssl](https://github.com/cloudflare/cfssl): Cloudflare PKI/TLS toolkit
- [RFC 5280: X.509 v3 Certificate](https://www.rfc-editor.org/rfc/rfc5280)

Control Plane

- [kube-apiserver flag reference](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/)
- [Static Pods](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
- [kubeadm](https://kubernetes.io/docs/reference/setup-tools/kubeadm/)
- [etcd](https://etcd.io/), [Raft paper](https://raft.github.io/)
- [Admission Controllers Reference](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- [OPA Gatekeeper](https://open-policy-agent.github.io/gatekeeper/), [Kyverno](https://kyverno.io/)

Container Runtime, Node

- [containerd](https://containerd.io/), [CRI spec](https://kubernetes.io/docs/concepts/architecture/cri/)
- [runc](https://github.com/opencontainers/runc), [OCI Runtime Spec](https://github.com/opencontainers/runtime-spec)
- [kubelet reference](https://kubernetes.io/docs/reference/command-line-tools-reference/kubelet/)
- [Container Runtimes: cgroup drivers](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)

Networking, CNI

- [The Kubernetes Networking Guide](https://www.tkng.io/)
- [CNI spec](https://github.com/containernetworking/cni/blob/main/SPEC.md)
- [containernetworking/plugins](https://github.com/containernetworking/plugins): bridge, host-local, and other reference implementations
- [Pod Network Routes (original guide chapter)](https://github.com/kelseyhightower/kubernetes-the-hard-way/blob/master/docs/11-pod-network-routes.md)
- [How kube-proxy works](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [CoreDNS](https://coredns.io/), [Kubernetes DNS Specification](https://github.com/kubernetes/dns/blob/master/docs/specification.md)
- [Flannel](https://github.com/flannel-io/flannel), [Calico](https://www.tigera.io/project-calico/), [Cilium](https://cilium.io/)

Linux Foundations (namespace, cgroup, bridge)

- [`man 7 namespaces`](https://man7.org/linux/man-pages/man7/namespaces.7.html)
- [`man 7 cgroups`](https://man7.org/linux/man-pages/man7/cgroups.7.html)
- [`ip-link(8)`](https://man7.org/linux/man-pages/man8/ip-link.8.html), [`ip-netns(8)`](https://man7.org/linux/man-pages/man8/ip-netns.8.html)
- [`br_netfilter` documentation](https://www.kernel.org/doc/Documentation/networking/bridge.txt)

Source Code References

- [apiserver authentication pipeline](https://github.com/kubernetes/kubernetes/tree/master/staging/src/k8s.io/apiserver/pkg/authentication)
- [Built-in ClusterRoleBindings](https://github.com/kubernetes/kubernetes/blob/master/plugin/pkg/auth/authorizer/rbac/bootstrappolicy/policy.go)
- [Node Authorizer implementation](https://github.com/kubernetes/kubernetes/tree/master/plugin/pkg/auth/authorizer/node)
- [kubelet static pod manifest watcher](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/config/file.go)
- [kube-controller-manager](https://github.com/kubernetes/kubernetes/tree/master/cmd/kube-controller-manager), [kube-scheduler](https://github.com/kubernetes/kubernetes/tree/master/pkg/scheduler)
