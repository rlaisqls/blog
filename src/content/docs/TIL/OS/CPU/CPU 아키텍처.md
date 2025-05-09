---
title: 'CPU 아키텍처'
lastUpdated: 2025-04-28T22:54:25
---

## Instruction Set Architecture

- ISA는 CPU가 이해하고 실행할 수 있는 명령어 집합이며, 특정 아키텍처의 하드웨어와 소프트웨어 간의 인터페이스이다.
- 각각의 CPU 아키텍처는 고유한 ISA를 가진다.
- 이 명령어 집합들은 운영체제와 어플리케이션에 사용된다.

## CPU 아키텍처

- CPU의 설계와 명령어 집합(ISA)을 정의하는 방식이다.
- 아키텍처란 다른 하드웨어와 소프트웨어 간의 상호 작용을 가능하게 하는 인터페이스이다.
- CPU의 내부 구성 요소, 데이터 버스, 레지스터, ISA를 포함하는 시스템의 전반적인 구조와 동작을 나타내는 개념이고, ISA는 CPU가 이해하고 실행할 수 있는 명령어 집합을 정의하는 개념이다. 엄밀하게는 약간의 차이가 있지만 서로 교환 가능한 용어이다.

### CPU 아키텍처 종류

- **x86**
  - Intel 기반 32bit CPU
  - x86은 32bit CPU의 대표명사처럼 불린다.
  - Windows, Linux, Mac OS (BigSur까지) 지원
- **x86_64** (amd64)
  - Intel 기반 64bit CPU, x86과 호환된다.
  - Windows, Linux, Mac OS (BigSur까지) 지원
- **arm**
  - RISC(Reduced Instruction Set Computer) 아키텍처
  - 저전력 소비, 높은 효율성
  - arm 기반 32bit CPU
  - x86과 아예 달라서 호환이 불가능하다.
  - Linux, Mac OS (Monterey부터), Android, iOS
- **arm64**
  - arm 기반 64bit CPU, 32bit arm과 호환된다.
  - Linux, Mac OS (Monterey부터), Android, iOS
  - 같은 소스 코드이지만 컴파일 환경이 다르면 다른 실행 파일이 생성된다.
  - x86_64에서 실행하도록 컴파일 된 파일은 x86_64의 ISA를 사용해서 컴파일됨.
  - arm64에서 실행하도록 컴파일 된 파일은 arm64의 ISA를 사용해서 컴파일됨.
  - x86_64에서 실행되도록 컴파일된 파일을 arm64에서 실행하려면 해당 파일을 arm64 ISA에 맞게 재컴파일하여 새로운 실행 파일을 생성하거나, 크로스 컴파일러를 사용해야 함.

### 크로스 컴파일

- 일반적으로 컴파일러는 동일한 플랫폼에서 실행되는 바이너리 파일을 생성한다.
- 그러나, 다른 플랫폼의 아키텍처에서 돌아갈 수 있도록 컴파일하는 것을 크로스 컴파일이라고 한다.
  - 맥북에서 안드로이드 스튜디오를 설치하고 소스코드를 빌드해서 apk 실행파일을 만든 것을 크로스 컴파일 과정으로 볼 수 있다.
    
### 운영체제와 CPU 아키텍처

- 각각의 운영체제는 다양한 CPU 아키텍처를 지원한다.
- Linux도 x86_64, arm64 등 다양한 아키텍처에서 실행될 수 있음.
- Linux나 Windows 운영체제에서 x86이라고 부르면 32bit CPU 전용 OS이고, x64라고 부르면 64bit CPU 전용 OS라고 통용된다.
- 하지만 특정 버전의 운영체제가 특정 CPU 아키텍처를 지원하지 않을 수 있다.
- Intel Mac은 CPU가 x86_64이기 때문에 이를 지원하는 운영체제를 사용하고, M1 Mac은 CPU가 arm이기 때문에 이를 지원하는 다른 버전의 운영체제를 쓴다.

> M1 Mac에서 인텔용 프로그램이 돌아가는 이유는 Rosseta 에뮬레이터 덕분이다.<br/>
> arm 내부에 x86 가상환경을 만들고, 그 안에서 실행하는 방식이다.

### 운영체제 별 실행파일

- 소프트웨어는 실행되기 위해 컴파일 되어야 한다.
- 하지만 대부분의 라이브러리는 특정 CPU 아키텍처에 맞게 사전 컴파일 되어있어서, 해당 라이브러리를 활용해서 컴파일한다.
  - Linux: `\*.so`
  - 윈도우: `\*.dll`
- 프로그램은 컴파일된 바이너리이다.
- 따라서 어떤 운영체제에서, 어떤 CPU 아키텍처에 대해 컴파일 했는지에 따라 결과물이 달라진다.

---
참고
- https://bumday.tistory.com/65
- https://inyongs.tistory.com/108
- https://blog.naver.com/PostView.nhn?blogId=mumasa&logNo=221049608979
- https://velog.io/@480/%EC%9D%B4%EC%A0%9C%EB%8A%94-%EA%B0%9C%EB%B0%9C%EC%9E%90%EB%8F%84-CPU-%EC%95%84%ED%82%A4%ED%85%8D%EC%B2%98%EB%A5%BC-%EA%B5%AC%EB%B6%84%ED%95%B4%EC%95%BC-%ED%95%A9%EB%8B%88%EB%8B%A4

