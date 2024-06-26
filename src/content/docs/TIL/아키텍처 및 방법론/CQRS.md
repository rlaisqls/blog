---
title: 'CQRS'
lastUpdated: 2022-12-05T13:21:13
---

 CQRS는 Command Query Responsibility Segregation 의 약자로, 단어 그대로 해석하면 "명령 조회 책임 분리"를 뜻한다. 즉, 우리가 보통 이야기하는 CRUD(Create, Read, Update, Delete)에서 CUD(Command)와 R(Query)의 책임을 분리하는 것이다.

### CQRS가 필요한 이유

 Application의 Business 정책이나 제약은 데이터 변경(CUD)에서 처리되고, 데이터 조회(R) 작업은 단순 데이터 조회를 처리하는데, 두가지 작업 모두를 동일 Domain Model로 처리하면 필요하지 않은 Domain 속성들이 생겨 복잡도가 증가한다. 도메인의 여러 속성들이 얽히면 유지보수의 비용이 증가하고 Domain model은 설계의 방향과 다르게 변질될 수 있다.
 
 따라서 명령을 처리하는 책임과 조회를 처리하는 책임을 분리하여 각각의 작업에 맞는 방식을 사용하여 최적화하는 CQRS 패턴이 필요하다.
 
### CQRS의 장점

#### 독립적인 크기 조정

 - 읽기 및 쓰기의 워크로드를 독립적으로 확장할 수 있다. CQRS를 사용하면  CUD 작업보다 R작업이 더 많이 일어나는 경우에, 읽기 작업을 담당하는 DB만 성능을 높이는 식으로 유연하게 대응할 수 있다.

#### DB 최적화

  - 각 작업에 맞게 알맞는 DB를 선택하여 성능을 개선할 수 있다. polyglot 구조를 사용해 수정용 DB는 RDBMS로, 읽기 전용 DB를 NoSQL로 구분하여 사용하는 등, 각각의 Model에 맞게 저장소를 튜닝하여 사용할 수 있기 때문에 성능 튜닝에 용이하다. Event Sourcing과 함께, Queue(AWS SQS, RabbitMQ, Kafka와 같은 Message Queue 등등)를 이용하여 비동기적으로 데이터를 쓰고 읽어오도록 만들 수도 있다.

#### 단순한 쿼리

  - 읽기 데이터베이스에서 구체화된 뷰를 저장하여 쿼리 시 복잡한 조인을 방지할 수 있다. CUD 작업을 같은 DB에서 진행할떄에는 힘들었던 반정규화를 보다 적극적으로 도입할 수 있다.

### 주의할 점

작은 애플리케이션의 경우에는 CQRS를 도입하는 것이 시스템을 불필요할 정도로 복잡하게 만들 수 있다.

모델의 적절한 경계를 구분할 수 있는 DDD 방법론을 기반으로 한 도메인 모델링이 필요할 수 있다.

---

### CQRS 구현하는 법
CQRS 패턴은 다양한 방법론과 기술을 통해 구현할 수 있다.

<img src="https://images.velog.io/images/_koiil/post/87fc04e2-e7c0-4373-81ac-66f029766539/%E1%84%89%E1%85%B3%E1%84%8F%E1%85%B3%E1%84%85%E1%85%B5%E1%86%AB%E1%84%89%E1%85%A3%E1%86%BA%202022-03-03%20%E1%84%8B%E1%85%A9%E1%84%92%E1%85%AE%201.11.56.png"/>

위는 CQRS 패턴을 점진적으로 적용하는 모습을 설명하는 그림이다.

1. 간단한 CRUD 애플리케이션 

 - 엔티티를 가져와서 수정하고, 엔티티를 직접 조회하는 간단한 애플리케이션이다. 위에서 서술한 바와 같이, 이와 같은 애플리케이션은 도메인의 복잡성이 증가하고, 읽기, 또는 쓰기에만 적용되는 데이터들이 많아지는 경우에 유지보수가 어렵다.

2. DTO 사용

 - 엔티티를 통해 조회하는 것이 아닌, 데이터 응답용 DTO를 사용하여 사용자에게 정보를 전달한다. 도메인 모델에 반환용 데이터를 포함시킬 필요가 없기 때문에 R과 CUD 작업을 분리하고, 읽기에 필요한 데이터를 구분하여 저장할 수 있다.

3. Polyglot 

 - Command용 Database와 Query용 Database를 분리하고 별도의 Broker를 통해서 이 둘 간의 Data를 동기화 처리 하는 방식이다. 각각의 Model에 맞게 저장소(RDBMS, NoSql, Cache)를 튜닝하여 사용할 수 있기 떄문에 DB 성능 문제를 해결할 수 있다. 두 DB 사이를 이어주기 위해서 Kafka 등의 메세징 큐를 사용하기도 한다. (이벤트 소싱)

### 정리

CQRS는 아래와 같은 아키텍처 패턴과 방법론을 파생하거나 필요로 할 수 있으며, 최종적으로는 명령과 조회에 대한 책임이 별도의 애플리케이션으로 완벽히 분리된 형태로 구현될 수 있다.

- 이벤트 형태로 구현된 프로그래밍 모델 
- Event Sourcing
- Eventual Consistency
- Domain Driven Design

CQRS는 애플리케이션의 복잡도가 증가하는 경우에 큰 변화를 줄 수 있는 방법중 하나인 것 같다.

#### 참고하면 좋은 글/영상
<a href="https://www.popit.kr/cqrs-eventsourcing">나만 모르고 있던 CQRS & EventSourcing</a>

<a href="www.youtube.com/watch?v=BnS6343GTkY">[우아콘2020] 배달의민족 마이크로서비스 여행기</a>

<a href="https://martinfowler.com/bliki/CQRS.html">마틴파울러 블로그</a>
