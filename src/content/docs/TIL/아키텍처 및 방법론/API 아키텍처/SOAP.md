---
title: 'SOAP'
lastUpdated: 2022-12-06T10:04:35
---

SOAP는 **XML 형식의 고도로 표준화된 웹 통신 프로토콜**이다. XML-RPC 출시 1년 후에 SOAP가 출시되었기 때문에 SOAP는 XML-RPC로부터 상당 부분을 물려받았다. 이후 REST가 출시되었을 때, SOAP와 REST는 같이 사용되었지만, 곧 REST만 사용하는 추세가 시작되었다.

## SOAP의 동작 방식

SOAP 메시지는 다음과 같이 구성된다.

- 메시지의 시작과 끝을 표시하는 envelop tag
- 요청 또는 응답 body
- 메시지가 특정 사항이나 추가 요구 사항을 결정해야되는지에 대한 정보를 나타내는 헤더
- 요청을 처리하는 도중 발생할 수 있는 오류에 대한 안내

<img height=300px src="https://user-images.githubusercontent.com/81006587/205660391-cea9b0e3-b444-4b86-89bb-5d66f6cf2a5e.png"/>

SOAP API 로직은 웹 서비스 기술 언어(WSDL)로 작성된다. 이 API 기술 언어는 endpoint를 정의하고 실행 가능한 모든 프로세스를 설명한다. 이를 통해 다양한 프로그래밍 언어와 IDE에서 통신 방법을 빠르게 설정할 수 있다.

SOAP는 **stateful, stateless 메시지 모두 지원**한다. Stateful 메시지를 사용하는 경우, 매우 과중할 수 있는 응답 정보를 서버에서 저장하게 된다. 그러나 이는 <u>다양하고 복잡한 트랜잭션을 처리하기에 적합</u>하다.

### SOAP의 장점

### 1. 언어 또는 플랫폼의 제약을 받지 않는다.

- SOAP는 웹 기반 서비스를 생성하는 내장 기능을 통해 통신을 처리하기 때문에 응답 언어 및 플랫폼으로부터 자유롭다.

### 2. 다양한 통신 프로토콜을 사용할 수 있다.

- SOAP는 전통신 프로토콜 측면에서 다양한 시나리오에 사용될 수 있도록 설계되어있다.

### 3. 에러 처리 기능을 내장한다.

- SOAP API 사양은 에러 코드와 설명을 담은 XML 재시도 메시지를 반환하도록 명시한다.

### 4. 보안 측면에서 확장 가능하다.

- WS-Security 프로토콜과 통합된 SOAP는 엔터프라이즈급 트랜잭션 품질을 충족한다. SOAP는 메시지 수준에서 암호화를 허용하면서 트랜잭션 내부의 개인 정보 보호 및 무결성을 제공한다.

<img height=300px src="https://user-images.githubusercontent.com/81006587/205661001-fc3d5cca-5f9f-44b1-8d3d-931bc8601e4e.png"/>

## SOAP의 단점

1. XML만 사용한다.
   - SOAP 메시지에는 많은 메타 데이터가 포함되며 요청 및 응답을 위해 장황한 XML의 특화 구조가 필요하다.

2. 전송 용량이 무겁다.
   - 큰 XML 파일 사이즈로 인해, SOAP 서비스는 큰 대역폭을 요구한다.

3. SOAP는 협소하게 전문화된 지식을 사용한다.
   - SOAP API 서버 설계는 모든 프로토콜과 매우 제한적인 규칙에 대한 깊은 이해도를 요구한다.

4. SOAP 사용 예시
   - SOAP 아키텍처는 일반적으로 기업 내 또는 믿을 수 있는 협력사와 내부 통합이 필요한 경우 사용된다.

SOAP는 주로 **고수준의 보안 데이터 전송**에 사용된다. SOAP의 엄격한 구조, 보안 및 권한 부여 기능은 API 공급자와 API 소비자 간의 법적 계약을 준수하면서 API와 클라이언트 간의 공식 소프트웨어 계약을 시행하는 데 가장 적합한 옵션이다. 이것이 금융 기관 및 기타 기업 고객이 SOAP를 사용하는 이유이다.