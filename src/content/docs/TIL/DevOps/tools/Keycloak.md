---
title: 'Keycloak'
lastUpdated: 2024-03-13T15:17:56
---

[Keycloak](https://www.keycloak.org/)은 ID 및 액세스 관리 솔루션을 제공하고, 인증(Authentication)과 인가(Authorization)을 쉽게 해주고 SSO(Single-Sign-On)을 가능하게 해주는 오픈소스이다.

### SSO란?

SSO는 Single-Sign-On의 약자로 한번의 로그인을 통해 그와 연결된 여러가지 다른 사이트들을 자동으로 접속하여 이용할 수 있도록 하는 방법이다.

일반적으로는 여러 사이트를 사용할 떄 각각의 DB에 각각의 사용자 정보가 있고 그 정보를 통해서 관리를 하게 되는데, 필요에 따라서는 사용자 정보를 연동하여 사용해야 하는 경우가 발생한다. 이런 경우에 SSO 기능을 사용하게 되며 하나의 시스템에서 인증을 할 경우 그와 연결된 다른 시스템에서는 인증 정보가 있는지 없는지를 확인하여 이후 처리를 하도록 만들면 되는 것이다.

즉, 하나의 아이디와 패스워드를 통해 여러 시스템에 접근할 수 있도록 하는 통합 인증 솔루션인 것이다.

예를 들어 하나의 회사 내부에서 다양한 시스템을 운영하고 있는 경우, 시스템 각각에 대해 사원 정보가 중복으로 존재할 필요가 없기에 SSO 인증 방식으로 사용하는게 적합하다.

### 기능
- 다중 프로토콜 지원
    - OpenID Connect, OAuth 2.0 및 SAML 2.0의 세가지 프로토콜을 지원한다. (OIDC는 인증, OAuth 2.0은 인가에 목적을 둔 프로토콜이다)
- SSO
    - 싱글 사인온 및 싱글 사인아웃을 지원한다.
- 관리자 콘솔
    - 웹 기반 GUI로 관리자 콘솔을 제공한다.
-   사용자 ID 및 액세스
    - 사용자 지정 역할 및 그룹으로 사용자 데이터베이스를 생성할 수 있도록 하여 독립 실행형 사용자 ID 및 액세스 관리자로 사용할 수 있다.
    - 애플리케이션 내에서 사용자를 인증하고 사전 정의된 역할을 기반으로 애플리케이션의 일부를 보호하는데 추가적으로 사용될 수 있다.
- 외부 ID 소스 동기화
    - 현재 어떤 유형의 사용자 데이터베이스가 있는 경우 해당 데이터베이스와 동기화할 수 있다.
- 신원 중개
    - 사용자와 일부 외부 ID 공급자 또는 공급자간의 프록시로 작동할 수 있다.
- 소셜 로그인
    - 관리자 패널에서 설정을 통해 소셜 ID를 사용할 수 있다. (google, twitter, stack overflow ..)
- 페이지 사용자 정의
    - 사용자에게 표시되는 모든 페이지에 대해 사용자 지정을 할 수 있다.

### keycloak 사용해보기

지원하는 도커 이미지를 실행시켜보자

```bash
docker run -d --name keycloak -p 8080:8080 -e KEYCLOAK_USER=admin -e KEYCLOAK_PASSWORD=admin jboss/keycloak:10.0.0
```

keycloak을 실행시킨 뒤 `localhost:8080/auth`로 접속하면 관리자 콘솔에 접속할 수 있다.

docker로 실행시킬 때 설정해준 아이디와 패스워드를 사용하면 관리자 계정으로 로그인할 수 있다.


### keycloak 용어 정리
**Realm**
- keycloak에서 Realm은 인증, 권한 부여가 적용되는 범위의 단위이다. SSO 기능을 적용한다고 했을 때 SSO가 적용되는 범위가 하나의 Realm 단위인 것이다.
처음 접속을 하면 보이는 Master realm은 첫번째 keycloak을 만들면 자동으로 생성되는 realm이며 add realm 버튼을 통해 쉽게 다른 realm을 추가할 수 있다.

**Client**
- keycloak에서 Client는 인증, 권한 부여 행위를 수행할 어플리케이션을 나타내는 단위이다.
하나의 realm 안에는 여러 개의 client가 들어갈 수 있으며 realm의 관리자가 각각의 client를 관리할 수 있다.
client는 보통 서비스 단위로 생성하고 관리하면 된다!

**User**
- keycloak에서 User는 인증을 필요로하는 사용자를 나타낸다.
기본적으로 User 정보는 username, email, firstname, lastname으로 구성되어 있지만 custom user attribute를 사용하여 원하는 속성을 추가할 수 있다. (다만, 추가된 항목이 사용자 등록 및 관리 화면에도 출력되도록 하기 위해서는 커스텀 테마 등록 및 수정이 필요하다)

**Role**
- keycloak에서 Role은 User에게 부여할 권한의 내용을 나타낸다. 단어 뜻 그대로 User에게 어떤 역할을 부여할 것인지에 대한 내용이라고 생각하면 된다.
