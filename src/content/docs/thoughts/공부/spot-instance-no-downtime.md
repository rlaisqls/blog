---
title: Downtime 없는 Spot Instance 클러스터 구축 과정
lastUpdated: 2023-12-20T11:17:10
---

## Xquare 인프라 

가용성 높은 spot instance 클러스터를 구축한 경험에 대해 이야기하기 전에<br>
해당 인프라를 구축했던 **Xquare 인프라** 프로젝트에 대해 먼저 설명해보겠다.

Xquare 인프라란 대덕소프트웨어마이스터고에 있는 여러 동아리의 프로젝트를 한 인프라에서 통합하여 관리하기 위한 프로젝트이다. PaaS 형태의 통합 인프라를 통해 학생들이 서버 성능이나 관리, 비용 부담 없이 프로젝트를 배포하고 사용할 수 있도록 하는 것이 목적이다.

각 동아리가 신청 폼으로 액세스 키를 발급받으면, 제공되는 배포 파이프라인을 통해 Xquare 인프라에 프로젝트를 마음껏 올릴 수 있다. 프로젝트 진행 시에 서버 관리나 비용에 대해 신경 쓸 필요 없이 빠르게 배포할 수 있게 된다.

현재 5개 동아리에서 개발하는 6개의 서비스, 100여개의 컨테이너를 인프라에서 관리 중이며, 교내 선생님과 학생을 포함한 약 250명의 유저가 배포된 서비스를 사용하고 있다.

컨테이너의 갯수가 자주 변동할 수 있기 때문에, Kubernetes(EKS)를 사용하여 쉽게 관리할 수 있도록 하였다.

![image](https://github.com/rlaisqls/TIL/assets/81006587/b8089b5d-719f-49d9-9e70-373dd2c25285)

<p style="color: #AAAAAA">Xquare 인프라 구조도</p>

### 문제 상황

적은 예산 내에서 여러 컨테이너를 감당해야 했기에, 모든 Node를 가격이 저렴한 [Spot Instance](https://docs.aws.amazon.com/ko_kr/AWSEC2/latest/UserGuide/using-spot-instances.html)로 구성했다.

전체 Node를 Spot Instance로 구성함으로써 EC2 비용을 **기존 대비 70%가량 절감할 수 있었다**.

> 💡 **Spot Instance란?** <br>
> AWS EC2를 사용할 수 있는 옵션 중에 하나로, 경매를 통해 저렴한 가격으로 리소스를 사용할 수 있게 해준다.
> 특정 가격으로 사용을 시작한 뒤, 경매 가격이 사용하고 있는 가격보다 올라가면 EC2가 정지된다는 특성이 있다.

AWS의 ASG(Auto Scaling Group) 기능을 사용하면 EKS에서 사용하는 전체 노드의 갯수를 지정해서 Spot Instance가 죽는 경우 새 Spot 노드를 생성하게 할 수 있다. 

이 때, AWS는 사용자가 Spot 노드가 죽는 것에 대비할 수 있도록 2분 전에 미리 알림을 보내준다. 이 프로젝트에서도 미리 알림을 받아 Pod를 다른 곳에 미리 옮겨놓을 수 있도록 [Node Termination Handler](https://github.com/aws/aws-node-termination-handler)라는 소스를 사용했다. 

그러나 Spot Instance의 특성으로 Node가 불시에 내려가면 서버 작동이 비주기적으로 10분 이상 정지하는 현상이 발생했다.

```jsx
termination을 기다리는 시간 약 2분 +
새 node 생성을 기다리고, node가 EKS에 등록되어 ready 되는 약 4~5분 +
애플리케이션이 올라가는 시간 약 3분 (여러 컨테이너가 동시에 시작되어 지연됨)
```

이렇게 총 10분 가량, 혹은 그 이상의 시간동안 정지하게 된다.

하루에 3번 이상 정지로 인한 문제가 발생했기에 가용성이 97% 수준이었고, 이로 인해 인프라에 대한 불편이 컸다. 따라서 Spot Instance 노드가 내려가도 그 안에있는 서버(Pod)는 계속해서 요청을 받을 수 있도록 개선할 방법을 생각해야 했다.

## 1. Karpenter 사용

 ASG 대신 Karpenter를 사용하면 node가 내려간 이후에 새 node를 바로 생성할 수 있고, node 생성 및 대기 시간을 줄일 수 있다. Karpenter의 이점을 알아보기 위해 우선 CA의 개념과 ASG의 동작에 대해 간략하게 설명해보겠다.

### **Cluster Autoscaler(CA)**

**Cluster Autoscaler**는 [autoscaler](https://github.com/kubernetes/autoscaler)라는 쿠버네티스의 공식 서브 프로젝트 중 하나이며, 클러스터의 워커 노드를 유동적으로 스케일링해주는 컴포넌트이다. 워커 노드의 자원이 모두 소모된 경우 자원이 더 필요하다고 판단하면 새로운 클러스터를 생성, 더 이상 새로운 자원이 필요하지 않게되면 생성된 클러스터를 삭제하는 동작을 한다.

이 동작은 Cloud Provider에게 요청하여 이뤄진다. AWS에서는 이 동작이 [ASG](https://docs.aws.amazon.com/ko_kr/autoscaling/ec2/userguide/auto-scaling-groups.html)를 통해 이뤄진다. CA는 Pod 의 상태를 관찰하다가 지속해서 할당에 실패하면 Node Group 의 ASG Desired Capacity 값을 수정하여 Worker Node 개수를 증가하도록 설정한다.

- **AWS Cluster Autoscaler 동작 과정**
    
    ![image](https://github.com/rlaisqls/TIL/assets/81006587/4af43a86-94ae-4390-8a5c-2e22690012a1)
    
    1. unscheduled Pod 를 관찰하고 있다가, Node Group 의 ASG Desired Capacity 값을 수정하여 Worker Node 개수를 증가하도록 설정한다.
    2. 이를 인지한 ASG 가 새로운 Node를 추가한다.
    3. 여유 공간이 생기면 kube-scheduler 가 Pod를 새 Node에 할당한다.

Cluster Autoscaler는 이와 같이 AutoScaling Group의 desired size를 조정하여 새로운 node를 provisioning하므로 반응 속도가 느리다. 이 문제를 해결하기 위해 Karpenter라는 툴을 사용할 수 있다.

### **Karpenter**

**[Karpenter](https://karpenter.sh/)** 는 AWS 가 개발한 Kubernetes 의 Worker Node 자동 확장 기능을 수행하는 오픈소스 프로젝트이다. 앞서 말한 Cluster Autoscaler (CA) 와 비슷한 역할을 수행하지만, AWS 리소스에 의존성이 없어 JIT(Just In-Time) 배포가 가능하다.

- **Karpenter 동작 과정**
    
    ![image](https://github.com/rlaisqls/TIL/assets/81006587/d256a919-dc9b-4250-b51f-c7501fc62980)

    1. unscheduled Pod 를 관찰하고 있다가, 새로운 Node 추가를 결정하고 직접 배포한다.
    (이때 Pod에 toleration 설정이 되어있어야 Karpenter가 인식해준다.)
    2. 추가된 Node가 Ready 상태가 되면 kube-scheduler 대신 pod의 Node binding 요청을 수행하기도 한다.

Karpenter는 클러스터 확장 시 일어나는 많은 부분을 직접 처리해서 확장을 처리한다.

이러한 특징 덕분에 ASG 대신 Karpenter를 사용함으로써 node가 내려간 이후에 새 node를 바로 생성하는 데 걸리는 지연 시간을 줄일 수 있었다.

## 2. Pod **Disruption Budget**

[PDB](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)란 활성화 상태여야 하는 pod의 수, 또는 정지될 수 있는 최대 pod의 수를 지정하여 유지할 수 있도록 강제하는 object이다. PDB를 사용하면 중요한 워크로드가 내려가는 것을 방지할 수 있기 때문에 서비스(애플리케이션)의 고가용성을 유지하는 데 도움을 준다. ([참고](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/#configure-poddisruptionbudget))
  
단, Xquare에서는 Replica를 1개만 가지고 있었기에 유의미한 동작을 할 수 없었다.  Cordon 되어도 PDB로 인해 node에 남아있다가, node가 삭제될 때 같이 삭제되었다가 그냥 재생성되기 때문에 PDB로 인한 삭제 방지가 동작하지 않는다.

만약 Replica를 2개로 만든다면 PDB 설정으로 노드 정지에 대응할 수 있지만 그만큼 더 많은 노드를 유지하기 위한 비용을 지출해야한다. 하지만 Xquare 인프라에선 이미 총 100여개의 pod를 돌리고 있는 상황에서 Replica 증가로 늘어나는 비용을 감당할 수 없었다. 따라서 PDB만으로는 이 프로젝트에서의 요구사항을 충족시킬 수 없다. 

**→** 완벽하지 않더라도 리소스를 최대한 덜 사용하면서 가용성을 늘릴 방법이 필요했다.

## 3. node Drain시 replica 2개로 늘리기

PDB를 설정하여도 Replica가 1개이기 때문에 문제가 생긴다면, 노드가 죽는 경우 Replica를 2개로 만들어주어 해결할 수 있지 않을까?하는 아이디어가 생각났다. 구체적인 흐름은 아래와 같다.

**가설**

1. **PDB minAvailable 값 1로 설정**
2. Drain 직전 해당 node에 pod를 가지고 있는 Deployment(app label로 식별)의 **Replica를 2**로 설정
3. **Node Drain**
    - 이때 Replica가 증가함으로써 다른 노드에 Pod가 새로 생기고 있는 상태 
    (PDB로 인해 기존 Pod가 사라지지 않고 트래픽을 받음)
    - ReadnessProbe 성공시 Drain으로 인해 기존 Pod 삭제
4. **새로 만든 Pod에서 트래픽 받기 시작, Replica 1로 복구**

**구현**

위의 플로우를 구현하기 위해 Node Termination Handler(v1.20.0)에서 이벤트에 대응하는 부분에 추가 로직을 작성했다. 소스는 이곳에서 [확인](https://github.com/team-xquare/node-termination-handler/blob/afe9c70cbe81c82c4e1b391d2caa2c005b754a1e/pkg/node/node.go#L106)할 수 있다.

추가한 부분은 주석으로 표기해놓았다.

```go
// CordonAndDrain will cordon the node and evict pods based on the config
func (n Node) CordonAndDrain(nodeName string, reason string, recorder recorderInterface) error {
	if n.nthConfig.DryRun {
		log.Info().Str("node_name", nodeName).Str("reason", reason).Msg("Node would have been cordoned and drained, but dry-run flag was set.")
		return nil
	}
	err := n.MaybeMarkForExclusionFromLoadBalancers(nodeName)
	if err != nil {
		return err
	}
	err = n.Cordon(nodeName, reason)
	if err != nil {
		return err
	}
	// Delete all pods on the node
	log.Info().Msg("Draining the node")
	node, err := n.fetchKubernetesNode(nodeName)
	if err != nil {
		return err
	}
	// Emit events for all pods that will be evicted

	// <<<<<<<<<<<<<<<  추가한 부분 
	clientSet := n.drainHelper.Client 
	// >>>>>>>>>>>>>>> 추가한 부분 끝

	if recorder != nil {
		pods, err := n.fetchAllPods(nodeName)
		if err == nil {
			for _, pod := range pods.Items {
				// <<<<<<<<<<<<<<<  추가한 부분 
				// label 식별
				appValue := pod.Labels["app"]
				typeValue := pod.Labels["type"]
				log.Info().Msgf("pod %s found (app: %s, type: %s)", pod.Name, appValue, typeValue)

				// app label이 존재하고 type label이 fe 또는 be인 경우
				if appValue != "" && (typeValue == "fe" || typeValue == "be") {

					// pod에 대한 deployment 찾기
					deployments, err := clientSet.AppsV1().Deployments(pod.Namespace).List(
						context.TODO(), metav1.ListOptions{LabelSelector: fmt.Sprintf("app=%s", appValue)},
					)

					// 만약 deployment가 존재한다면
					if err == nil && len(deployments.Items) > 0 {
						deployment := deployments.Items[0]
						replicaCount := deployment.Spec.Replicas

						newReplicaCount := *replicaCount + 1
						deployment.Spec.Replicas = &newReplicaCount**

						// replica 1 증가시키기
						updatedDeployment, err := clientSet.AppsV1().Deployments(pod.Namespace).Update(
							context.TODO(), &deployment, metav1.UpdateOptions{},
						)
						log.Info().Msgf("Increase deployment %s's replica %d to %d", appValue, *replicaCount, newReplicaCount)
						if err != nil {
							panic(err.Error())
						}
					}
				}
				// >>>>>>>>>>>>>>> 추가한 부분 끝

				podRef := &corev1.ObjectReference{
					Kind:      "Pod",
					Name:      pod.Name,
					Namespace: pod.Namespace,
				}
				annotations := make(map[string]string)
				annotations["node"] = nodeName
				for k, v := range pod.GetLabels() {
					annotations[k] = v
				}
				recorder.AnnotatedEventf(podRef, annotations, corev1.EventTypeNormal, PodEvictReason, PodEvictMsgFmt, nodeName)
			}
		}
	}

	err = drain.RunNodeDrain(n.drainHelper, node.Name)
	if err != nil {
		return err
	}
	return nil
}
```

기존에는 replica가 1개였기 때문에 drain시 PDB 설정이 무시되어 pod 종료 → pod 생성 순서로 작동했는데 drain 전에 replica를 2개로 만들어주면 새 pod가 running 상태가 될 때 까지 이전 pod를 terminate시키지 않는다.

다른 Deployment에 대해 적용 시 안정성을 장담할 수 없어서 xquare 프로젝트의 pod에만 있는 label을 식별하여 늘려주도록 했다.

## 결과

위와 같이 구축 후 Uptimia 사이트를 사용해서 2023년 9월부터 2달간 측정한 결과, 모든 API 서버의 가용성이 99.95%를 유지하는 것을 볼 수 있었다.

<img width="705" alt="image" src="https://github.com/rlaisqls/TIL/assets/81006587/befb2139-d0d3-4ab1-b07f-55d5c279d1a7">

node가 cordon 되면 해당 node에 있던 pod들이 나머지 node에 스케줄링 되는데, 나머지 node에 자리가 부족한 경우(리소스가 모자란 경우) node가 삭제되고 다시 생성될 때까지 서버가 잠시 정지될 수 있다는 문제는 여전히 존재한다. 

이 문제는 전체 노드를 Spot Instance로 사용하는 상황에서 완벽하게 해결하기 어렵기에 현재 수준에서 타협하기로 했다. 해당 문제를 해결하기 위해 더 많은 비용을 쓰는 것 보다, 현재의 방법을 유지하는 것이 상황에 적절하다고 판단했다.

가용성 높은 spot instance 클러스터를 구축하기 위한 과정에서 Karpenter, NTH 등의 툴과 K8s의 Pod 스케줄링에 관련된 기능을 많이 공부할 수 있었다. 

문제를 해결하기 위해 다양한 방법을 시도하는 것이 정말 즐거웠다. 전체 node를 Spot Instance로 사용한다는 것 자체가 무모한 도전이었는데, 이러한 상황에서 최선을 다해 괜찮은 결과를 낼 수 있었다. 문제를 해결하기 위해 적극적으로 고민하는 경험을 할 수 있어 좋았다.
