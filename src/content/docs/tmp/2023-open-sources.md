---
title: 코드 까보기, 오픈소스 기여해보기
lastUpdated: 2024-01-11T11:17:10
tags: ["오픈소스"]
---


- 백엔드를 공부하며 스프링, JPA 등 오픈소스 코드를 까보는 데 흥미를 가지기 시작했다.
- 에러를 고치기 위한 목적으로, 또는 단순 기술에 대한 호기심으로, IDE의 디버깅 기능을 사용해 Springboot, JPA, Netty, Coroutine 등 라이브러리들의 코드를 많이 까봤다.
- 이 즈음의 TIL에 특정 라이브러리 구현에 대해 분석하는 글을 많이 썼다.
  - [@GeneratedValue 코드보기](https://github.com/rlaisqls/TIL/blob/0fd3d959f694db0c181e30b18cca64ea3af95c99/%EC%84%9C%EB%B2%84/Spring/JPA/%40GeneratedValue%E2%80%85%EC%BD%94%EB%93%9C%EB%B3%B4%EA%B8%B0.md?plain=1)
  - [Detached entity passed to perist](https://github.com/rlaisqls/TIL/blob/0fd3d959f694db0c181e30b18cca64ea3af95c99/%EC%84%9C%EB%B2%84/Spring/JPA/GenerateValue%E2%80%85Column%EC%97%90%E2%80%85%EA%B0%92%EC%9D%84%E2%80%85%EB%84%A3%EB%8A%94%EB%8B%A4%EB%A9%B4.md)
  - [netty 메시지 전송 흐름](https://github.com/rlaisqls/TIL/blob/0fd3d959f694db0c181e30b18cca64ea3af95c99/%EC%84%9C%EB%B2%84/netty/netty%E2%80%85%EB%A9%94%EC%8B%9C%EC%A7%80%E2%80%85%EC%A0%84%EC%86%A1%E2%80%85%ED%9D%90%EB%A6%84.md?plain=1)
  - [Coroutine Delay](https://github.com/rlaisqls/TIL/blob/0fd3d959f694db0c181e30b18cca64ea3af95c99/%EC%BD%94%EB%93%9C/%EB%B9%84%EB%8F%99%EA%B8%B0/coroutine/Coroutine%E2%80%85Delay.md)
  - 등등...
- 근데… 보다보니 너무 잘 짜여있어서 내가 이런 코드에 기여할 수 있는 부분이 있을지 의문이 들었다.
- 오픈소스에 기여해보는 게 좋은 경험이라는 얘기는 많이 들었지만 너무나도 막막했다.

---

- 백엔드 외의 다른 것을 시도해보고 싶어서 데브옵스로서 첫 프로젝트(Xquare)를 진행했다.
- 데브옵스 세팅을 하다보면 이상한 에러 로그가 답답할 정도로 많이 생기는데, 그럴 때면 주저없이 코드를 까봤다.
  - 해당 로그가 어디서 어떤 조건 때문에 찍히는 건지 보면 문제를 이해하기도 쉬웠다.
- 백엔드 할 때 보다 다양한 코드를 많이 까볼 수 있어서 너무너무 재밌었다.
  그래서 데브옵스로 취업을 준비하기로 결심하고 본격적으로 공부하기 시작했다.
- 계속 그렇게 공부하다보니 오픈소스 프로젝트에 대한 자세한 설명은 깃허브에 md 파일로 올라와 있는 경우가 많다는 것을 알았다. 자연스럽게 깃허브에서 정보를 찾아보는 경우가 잦아졌고, 이후 첫 기여 경험의 기반이 되었다.

---

#### Amazon VPC CNI K8s

- 프로젝트에 옵션을 적용하기 위해 Github를 찾아보다 도저히 이해가 가지 않는 문서를 만났다.
- node의 ENI에 서브넷마스크가 `/32`인 IP 대신, `/28`인 IP를 할당해서 한 node에 더 많은 IP를 할당하고, 더 많은 Pod를 사용할 수 있도록 하는 IP Prefix 모드 옵션에 대한 문서였다.
- 문서의 표의 한 행에서 Pod per ENIs의 값이 '48, 2'로 적혀있었는데, 설명대로라면 숫자의 합이 Pods의 값인 '58'이 나와야했다. 하지만 48과 2의 합은 50이니 뭔가 잘못되었음을 느꼈다.
- 처음에는 내가 잘못 이해했나 싶었는데 그날따라 왠지 내 생각에 확신이 들어 [PR](https://github.com/aws/amazon-vpc-cni-K8s/pull/2573)을 올려보았다.

  ![image](https://github.com/rlaisqls/TIL/assets/81006587/cff9e0e7-d700-40dc-953f-d702d52702a7)

- 근데 이게 머지됐다. (무려 바로 다음날!)
- 조금은 얼떨떨한 기분이었다. 별 거 아니었지만 나도 오픈소스에 조금이나마 기여할 수 있다는 자신감을 가지게 되었다.

  ![image](https://github.com/rlaisqls/TIL/assets/81006587/ad62fbeb-894e-4dc0-84c9-0512b2c0ff27)

#### Loki helm chart

- 그러던 어느 날, 프로젝트를 하다가 또 개선되면 좋겠다 싶은 소스를 발견했다.
- 올리게 된 스토리는 이와 같다.
- 프로젝트 서버를 구축할 때 EBS PV를 연결해서 사용하기에 비용이 부족해서, 비용 확보 전까지 로그 데이터를 S3에 저장하기로 결정했었다. 하지만 Loki helm chart에 statefulset에 대한 PV 설정을 끄는 옵션(empty dir을 사용하는 옵션)이 없어 chart 템플릿을 깃허브에서 다운받아 수정한 뒤 사용했다.
- 다른 사람들도 이 옵션을 필요로 할 수 있을 것 같아 helm chart에 옵션을 추가하는 작업을 한 후 [PR](https://github.com/grafana/loki/pull/10617)을 올렸다.

  ![image](https://github.com/rlaisqls/TIL/assets/81006587/0c54555e-3e11-4400-8091-7d7157b760e9)

- 하지만 이전에 올라온 동일한 내용의 PR이 있었기 때문에 이 PR은 결국 머지되지 못했다.
  (persistence 키워드로 검색했을 때 결과가 나오지 않아 동일 내용 PR이 없다고 생각했었다.)
- ‘이전에 올라온 PR에는 read 컴포넌트에 대한 persist 옵션이 없기 때문에 내 PR을 머지해야한다!’라고 주장해보았지만, 이전 PR을 올리신 분께서 read 컴포넌트에는 PVC를 사용하지 않고 deployment로 배포하는 옵션이 존재한다는 것을 친절하게 알려주셨다.
- 나의 실수를 인정하고 PR을 close하였다.

  ![image](https://github.com/rlaisqls/TIL/assets/81006587/91a629ff-74a6-4aaa-a390-91163e7c4927)

- 로직이 없는 단순 옵션 추가였지만 이전보다는 큰 규모의 수정이었는데, 기존 PR을 제대로 살펴보지 못해 close 되었다는 게 아쉬웠다. 앞으로는 기존에 유사한 이슈나 PR 시도가 있었는지 먼저 더 자세히 파악해야겠다고 생각했다.
- 오픈소스에 PR을 올려 메인테이너에게 리뷰를 받는 경험을 얻었다는 것에 일단 만족하기로 했다.
- 이러한 두 경험을 통해 오픈소스에 기여하는 과정에 대한 감을 어느정도 잡을수 있었다.

- 나도 깃허브에 있는 다양한 오픈소스에 보탤 수 있는 부분이 있다는 걸 알았다. 그리고 깃허브에서 코드에 있는 주석이나 디스커션, 이슈, PR을 통해 다른 개발자들이 써놓은 내용을 살펴보면 프로젝트에 대한 지식을 더 많이 얻고 깊게 이해할 수 있다는 걸 알았다.

- 내가 사용하는 기술이나 라이브러리의 구현에 대해 관심을 가지고 자세한 부분까지 이해하려고 노력했기 때문에 오픈소스에 조금이나마 기여해볼 수 있었다. 그래서 계속해서 깃허브에 있는 코드와 공식문서로 공부를 열심히 해나갔다.

---

#### Istio

- 시간이 지나고, 프로젝트가 어느정도 마무리되었다.
- 무엇을 하면 좋을까 고민하며 istio 레포지토리를 둘러보다가 Memory Autoscaling에 관련된 이슈를 발견했다. istio-operator에서 컴포넌트의 HPA 오브젝트를 이용해 memory 기반 스케일링 옵션을 추가해달라는 내용이었다.

- 이 이슈를 보니 HPA의 CPU와 memory 옵션에 대한 K8s 문서를 읽었던 기억이 떠올랐다.
- 내가 이해하는 범위에서 해결할 수 있는 이슈라는 생각이 들어 코드를 수정했다. ([PR 링크](https://github.com/istio/istio/issues/47649))

  ![image](https://github.com/rlaisqls/TIL/assets/81006587/65ffa06b-902b-4924-996f-73576e802be5)

- 하지만.. 코드를 작성한 후 단위 테스트를 돌려보니 테스트가 깨지고 있었다. operator가 컴포넌트를 생성하기 위해 쓰는 매니페스트를 수정했는데, 테스트에는 수정된 부분이 반영되지 않았다.
- 가상 환경에서 돌리는 통합 테스트 결과를 함께 보고 분석하고 싶어서 우선 PR을 올렸다. (올리기 전에 단위테스트를 먼저 고쳤다면 테스트가 깨진 PR을 리뷰하는 데 드는 수고를 덜 수 있었을 것 같아 아쉽다.)
- 그런데 로그를 아무리 봐도 문제가 뭔지 알 수 없었다. 학교 일정때문에 당장 코드를 더 볼 수 없는 상황이어서 PR을 올린지 4일만에 PR을 닫고 코멘트로 사과를 남겼다..

  ![image](https://github.com/rlaisqls/TIL/assets/81006587/3930b430-0961-4edd-90de-9827fd2a6ce1)

- 이대로 넘기긴 너무 아쉬웠다. 일정이 정리된 11월 말, 테스트 코드가 깨지는 이유를 다시 파보기로 결심했다.
  - 테스트 코드가 작동하는 과정에 디버깅을 쭉 찍어보면서 문제를 찾기 시작했다.
  - 다른 코드를 까본 경험이 있어 이러한 과정에 익숙했고 결국 문제를 찾을 수 있었다!
- 문제는 테스트 코드에서 쓰는 템플릿이 별도의 압축 파일로 분리되어있어 발생한 것이었다.
- 테스트 코드에서는 manifests 패키지에 있는 파일이 아니라, data-snapshot.tar.gz라는 이름의 압축 파일 안에 있는 템플릿을 사용해서 테스트를 수행하고 있었다.
- 나는 manifests 패키지의 템플릿만 수정했었기에 테스트코드에 반영되지 않았던 것이고, 변경사항을 반영하여 tar 명령어로 `data-snapshot.tar.gz` 파일을 다시 생성해주니 정상적으로 동작했다.

  ![image](https://github.com/rlaisqls/TIL/assets/81006587/99a209e3-36e6-4fb0-be65-b11ae1c90983)

- 몇 개의 리뷰를 더 받아 수정한 후 PR을 머지하게 되었다!

  ![image](https://github.com/rlaisqls/TIL/assets/81006587/8bfb16f7-43da-42c5-85ce-40036d145d09)

---

이 외에도 오픈소스에 크고 작은 기여를 하기 위해 항상 노력하고 있다. 앞으로도 계속해서 관심을 가지고 공부하면 더 크고 중요한 로직에 대한 기여도 해볼 수 있을거라 생각한다.

내 PR에서 가장 많이 달린 코멘트가 오타나 실수에 대한 것이었다는 점은 아쉽다. 내가 작업한 내용을 스스로 더 꼼꼼히 살펴봐야겠다고 생각했다. (꼭 다른 사람 코드 볼 땐 잘 보이는 오타들이 내 코드에선 눈에 잘 안 띄더라..)

내가 백엔드를 공부할 때 오픈소스에 기여하지 못했던 이유는 남의 코드를 보는 것보다 내 코드를 짜는 것을 중요하게 여겼기 때문인 것 같다. 반면 지금은 로직을 구현하기보다는 기술을 더 잘 가져다 쓰기 위해 많은 노력을 투자하고 있다. 분야의 차이도 있지만, 결국에는 오픈소스를 보는 것이 개발자들이 공통으로 필요로 하는 기술에 대한 수요를 파악하는 데는 가장 좋은 방법이라고 생각한다. 그런 의미에서 다른 사람들의 코드를 조금 더 잘 까볼 수 있는 사람이 되고 싶다.

깃허브라는 플랫폼으로 타지에 있는 개발자분들과 쉽게 소통하고, 서로의 코드를 공유하고, 의견을 나눌 수 있다는 건 정말 행복한 일인 것 같다.
앞으로도 다양한 코드를 잘 이해하고 활용할 수 있는 엔지니어가 될 수 있도록 노력해야겠다!

