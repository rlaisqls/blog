---
title: 'IP 데이터그램과 단편화'
lastUpdated: 2024-03-13T15:17:56
---

IP 데이터그램은 아래와 같은 형태로 구성되어있다.

<img width="594" alt="image" src="https://github.com/rlaisqls/TIL/assets/81006587/d7ddf240-feb8-4579-a56d-e1cb367b2ff9">

- `VERS`
  - 4비트로 데이터그램의 IP 프로토콜 버전을 명시한다. 다른 버전의 IP는 다른 데이터그램 형식을 사용하기 때문에 라우터는 버전 번호를 확인하여 데이터그램의 나머지 부분을 어떻게 해석하는지 결정한다.

- `HLEN`
  - IPv4 데이터그램은 헤더에 가변 길이의 옵션을 포함하기 때문에 4비트의 헤더 길이를 통해 IP 데이터그램에서 실제 페이로드가 시작하는 곳을 명시해준다. 대부분 IPv4 데이터그램은 옵션을 포함하지 않아서 데이터그램의 헤더는 20바이트가 통상적이다.

- `SERVICE TYPE`
  - 서비스 타입 비트는 서로 다른 유형의 IP 데이터그램을 구별한다.

- `TOTAL LENGTH`
  - 바이트로 계산한 IP 데이터그램(헤더와 데이터)의 전체 길이이다. 이 필드의 크기는 16비트이므로 IP 데이터그램의 이론상 최대 길이는 65,536(2^16)바이트이다.

- `IDENTIFICATION`, `FLAG`, `FRAGMENT OFFSET`: 세 필드는 IP 단편화와 관계되어있다. 아래에서 더 자세히 알아보자!

- `TTL(Time-To-Live)`
  - 이 필드는 네트워크에서 데이터그램이 무한히 순환하지 않도록 한다.

- `TYPE`(상위 계층 프로토콜)
  - 이 필드는 일반적으로 IP 데이터그램이 최종 목적지에 도달했을 때만 사용한다. 이 필드값은 IP 데이터그램에서 데이터 부분이 전달될 목적지의 전송 계층의 특정 프로토콜을 명시한다.

- `HEADER CHECKSUM`
  - 헤더 체크섬은 라우터가 수신한 IP 데이터그램의 비트 오류를 탐지할 수 있도록 돕는다.

- `SOURCE IP ADDRESS`, `DESTINATION IP ADDRESS`
  - 출발지가 데이터그램을 생성할 때, 자신의 IP 주소를 출발지 IP 주소 필드에 삽입하고 목적지 IP 주소를 목적지 IP 주소 필드에 삽입한다. 

- `IP OPTIONS`
  - 옵션 필드는 IP 헤더를 확장한다.

## 단편화

- Ipv4 데이터그램의 단편화는 **모든 링크 계층 프로토콜들이 같은 크기의 네트워크 계층 패킷을 전달할 수 없기** 때문에 필요하다.
  
- 어떤 프로토콜은 아주 많은 양의 데이터를 보내야할 수 있다. 그러나 링크 계층 프레임이 전달할 수 있는 최대 데이터 양은 제한되어있다(MTU).
  
- 그렇기 때문에 IP 데이터그램의 페이로드를 두 개 이상의 더 작은 IP 데이터그램으로 분할하고, 각각의 더 작아진 IP 데이터그램을 별로의 링크 계층 프레임으로 캡슐화하여 출력 링크로 보낸다. 
  
- 다시 말해, 만약 MTU 이상의 크기로 데이터가 전송된다면 패킷이 MTU 크기에 맞춰져서 분할하게 되는데 이것을 **단편화**(Fragmentation)라고 하고, 나눠진 작은 데이터그램 각각을 **단편**(Fragment)이라고 부른다.

- `IDENTIFICATION`, `FLAG`, `FRAGMENT OFFSET`은 데이터그램에서 단편화에 관련된 정보를 저장하는 필드이다.

- `IDENTIFICATION`
  - 패킷이 단편화 된 각각의 조각을 구분하기 위해 할당된 식별자이다. 
- `FLAG`
  - 단편의 특성을 나타내는 3비트의 플래그들이다. 순서대로 아래와 같은 의미이다.
    1. 미사용 (항상 0)
    2. Don't Fragment
        이 값이 1이면 단편이 불가능하다는 뜻
    3. More Fragment
        이 값이 1이면 뒤에 단편이 더 있다는 뜻
- `FRAGMENT OFFSET`
  - 분할된 패킷을 수신측에서 다시 재조합할때 패킷들의 순서를 파악하기 위해 사용된다.
  - 8 바이트 단위(2 워드)로 최초 분열 조각으로부터의 Offset을 나타낸다.
  - ex) 첫 단편 옵셋 : 0, 둘째 단편 옵셋 : 첫 단편 크기 만큼 (8 바이트 단위)

---
참고
- http://www.ktword.co.kr/test/view/view.php?m_temp1=5236