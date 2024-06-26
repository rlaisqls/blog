---
title: '웹서버와 WAS'
lastUpdated: 2024-05-22T08:39:15
---
## 웹 서버(Web Server)

웹 서버란 HTTP 프로토콜을 기반으로 클라이언트가 웹 브라우저에서 어떠한 요청을 하면 그 요청을 받아 **정적 컨텐츠**를 제공하는 서버이다. 정적 컨텐츠란 단순 HTML 문서, CSS, 이미지, 파일 등 즉시 응답 가능한 컨텐츠이다. 

이때 웹 서버가 정적 컨텐츠가 아닌 동적 컨텐츠를 요청받으면 WAS에게 해당 요청을 넘겨주고, WAS에서 처리한 결과를 클라이언트에게 전달하는 역할도 해준다.  

이러한 웹 서버에는 `Apache`, `NginX`등이 있다.

## WAS(Web Application Server)

WAS란 DB 조회 혹은 다양한 로직 처리를 요구하는 **동적 컨텐츠**를 제공하기 위해 만들어진 Application 서버이다. HTTP 프로토콜을 기반으로 사용자 컴퓨터나 장치에 애플리케이션을 수행해주는 미들웨어로서, 주로 데이터베이스 서버와 같이 수행된다.

WAS는 JSP, Servlet 구동환경을 제공해주기 때문에 서블릿 컨테이너 혹은 웹 컨테이너로도 불린다.

이러한 WAS는 웹 서버의 기능들을 구조적으로 분리하여 처리하고자 하는 목적으로 제시되었다. 분산 트랜잭션, 보안, 메시징, 쓰레드 처리 등의 기능을 처리하는 분산 환경에서 사용된다. WAS는 프로그램 실행 환경과 DB 접속 기능을 제공하고, 여러 개의 트랜잭션을 관리 가능하다. 또한 비즈니스 로직을 수행할 수 있다.

이러한 WAS에는 `Tomcat`, `JBoss`, `WebSphere` 등이 있다. 

## 웹 서버와 WAS

![image](https://user-images.githubusercontent.com/81006587/234428846-6fc537cd-f44c-4291-9975-0e26c61f58a7.png)
 
WAS는 Web Server와 Web Container의 역할을 모두 할 수 있다. 여기서 컨테이너는 JSP, Servlet을 실행시킬 수 있는 소프트웨어를 말한다. 현재 WAS의 웹 서버도 정적인 컨텐츠를 처리하는 데 성능상 큰 차이가 없다.

그렇다면 WAS가 웹 서버의 기능까지 모두 수행하면 되는 것일까? 무조건 그렇진 않고, 웹 서버와 WAS를 분리해야 하는 몇 이유들이 있다.

1. 서버 부하 방지

- WAS와 웹 서버는 분리하여 서버의 부하를 방지해야 한다. WAS는 DB 조회나 다양한 로직을 처리하고, 단순한 정적 컨텐츠는 웹 서버에서 처리해줘야 한다. 만약 정적 컨텐츠까지 WAS가 처리한다면 부하가 커지게 되고, 수행 속도가 느려질 것이다. 

2. 보안 강화

- SSL에 대한 암호화, 복호화 처리에 웹 서버를 사용 가능

3. 여러 대의 WAS 연결 가능

- 로드 밸런싱을 위해 웹 서버를 사용할 수 있다. 여러 개의 서버를 사용하는 대용량 웹 어플리케이션의 경우 웹 서버와 WAS를 분리하여 무중단 운영을 위한 장애 극복에 쉽게 대응할 수 있다. 

4. 여러 웹 어플리케이션 서비스 가능

- 하나의 서버에서 PHP, JAVA 애플리케이션을 함께 사용할 수 있다. 

이러한 이유로 웹 서버를 WAS 앞에 두고 필요한 WAS들을 웹 서버에 플러그인 형태로 설정하면 효율적인 분산 처리가 가능하다.

## Web Service Architecture

웹서버와 WAS를 둔 서비스의 전체 아키텍처와 동작 순서는 아래와 같다.

<img width="762" alt="image" src="https://user-images.githubusercontent.com/81006587/234429581-0754dfb1-e853-4544-88dc-0968f5b5386f.png">

1. 클라이언트의 요청을 먼저 웹 서버가 받은 다음, WAS에게 보내 관련된 Servlet을 메모리에 올린다.
2. WAS는 `web.xml`을 참조해 해당 Servlet에 대한 스레드를 생성한다. (스레드 풀 이용)
3. 이때 `HttpServletRequest`와 `HttpServletResponse` 객체를 생성해 Servlet에게 전달한다.
4. 스레드는 Servlet의 `service()` 메소드를 호출한다.
5. `service()` 메소드는 요청에 맞게 `doGet()`이나 `doPost()` 메소드를 호출한다.
6. `doGet()`이나 `doPost()` 메소드는 인자에 맞게 생성된 적절한 동적 페이지를 Response 객체에 담아 WAS에 전달한다.
7. WAS는 Response 객체를 HttpResponse 형태로 바꿔 웹 서버로 전달한다.
8. 생성된 스레드를 종료하고, `HttpServletRequest`와 `HttpServletResponse` 객체를 제거한다.

