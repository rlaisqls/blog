---
title: strace로 shaka-packager 버그 추적
lastUpdated: 2025-12-03T20:48:12
tags: ["strace", "System Call"]
---

[shaka-packager](https://github.com/shaka-project/shaka-packager) CLI를 사용해 여러 스레드에서 패키징 작업을 병렬로 실행하는 코드가 있었는데, 몇몇 스레드에서 간헐적으로 실패하는 버그가 발생했다.

대부분 mp4 파일 두 개까지는 잘 생성되다가 마지막 파일에서 실패하고, 재시도하면 또 성공하기도 하는 그런 종류의 버그였다. 에러 상황을 단순화하면 이런 식이었다:

```
1.mp4 처리 시작
2.mp4 처리 시작
3.mp4 처리 시작
2.mp4 출력 파일 생성 완료
1.mp4 출력 파일 생성 완료
3.mp4 출력 파일 생성 실패: Packaging Error: 5 (FILE_FAILURE) - Cannot open file to write
```

두 개까지는 잘 되다가 마지막 하나에서 에러 코드 5번 `FILE_FAILURE`가 났다. shaka-packager에서 파일 관련 작업이 실패했을 때 반환하는 에러 코드인데, 로그에서 원인이 보이지 않아서 꽤 골치가 아팠다.

일단 떠오르는 대로 여러 가설을 세우고 하나씩 확인해봤다.

- 패키저 버전 문제: 혹시 특정 버전에서만 발생하는 건가 싶어서 여러 버전으로 돌려봤는데 비슷한 비율로 실패했다. 버전 문제는 아닌 것 같았다.
- 특정 영상 문제: 어떤 영상 파일이 깨져있거나 포맷이 이상한 건가 싶었는데, 같은 영상을 다시 돌리면 성공하는 경우가 있었다. 영상 자체의 문제는 아니었다.
- 디스크/메모리 부족: 실행 전후로 리소스 상태를 확인해보니 디스크, 메모리 모두 영상 크기의 3배 이상 여유가 있었다. 2분짜리 짧은 영상에서도 발생해서 용량 문제도 아니었다.
- 파일 디스크립터 부족: fd가 모자라서 파일을 못 여는 경우도 있을테니 확인해봤는데, 15개 이하로 사용 중이었다. 이것도 아니었다.
- 입력 파일 개수: 여러 해상도의 mp4를 동시에 패키징하는 구조였는데, 입력 파일이 1개일 때는 문제가 재현되지 않았다. 여러 파일을 동시에 처리할 때만 실패했다.

## strace

뭘 더 봐야 할지 모르겠어서, 어떤 동작에서 문제가 발생하는지 시스템콜로 직접 보기로 했다.

> **strace란?**
>
> 프로세스가 호출하는 시스템콜을 추적하는 Linux 도구다. 프로세스가 커널에 요청하는 모든 작업(파일 열기, 읽기, 쓰기, 네트워크 통신 등)을 실시간으로 볼 수 있어서, 애플리케이션이 어떤 동작을 하는지 저수준에서 파악할 때 유용하다.

```bash
strace -ff -tt -y -i -o /tmp/strace ./packager ...
```

옵션을 설명하자면:

- `-ff`: 자식 프로세스나 스레드도 같이 추적한다. 각각 별도 파일로 저장되어서 나중에 스레드별로 비교하기 좋다.
- `-tt`: 마이크로초 단위 타임스탬프를 찍어준다. 동시성 문제를 잡을 때 이게 중요하다.
- `-y`: 파일 디스크립터 번호 대신 실제 파일 경로를 보여준다. `write(3, ...)` 대신 `write(3</tmp/foo.mp4>, ...)`처럼 나온다.
- `-i`: 명령어 포인터 주소를 찍어준다. 같은 시스템콜이 여러 곳에서 불릴 때 구분하는 데 쓸 수 있다.
- `-o /tmp/strace`: 출력 경로. 스레드마다 `/tmp/strace.12345` 같은 파일들이 생긴다.

성공 케이스와 실패 케이스 둘 다 strace를 떠놓고 비교해보기로 했다.

## 에러 찾기

우선 실패한 로그에서 에러를 찾아봤다. 실패한 파일명이 있었으니 그걸로 grep을 돌렸다.

```bash
grep "3.mp4" /tmp/strace.* | grep "= -1"
```

시스템콜이 실패하면 반환값이 `-1`이고 뒤에 에러 코드가 붙는다. 결과는 이랬다.

```
/tmp/strace.176:09:23:45.123456 openat(AT_FDCWD, "/tmp/output/3.mp4", O_WRONLY|O_CREAT|O_TRUNC, 0666) = -1 ENOENT (No such file or directory)
```

`openat`이 `ENOENT`로 실패했다. `O_CREAT` 플래그가 있으면 파일이 없을 때 새로 만드는데, [man 페이지](https://man7.org/linux/man-pages/man2/openat.2.html)를 찾아보니 상위 디렉토리가 없으면 ENOENT가 난다는 내용이 있었다. 그러면 디렉토리랑 연관있을 수 있겠다고 생각했다.

> ENOENT: A directory component in pathname does not exist or is a dangling symbolic link.

## 디렉토리 생성 추적

그러면 디렉토리는 언제 만들어지는 걸까? 디렉토리를 생성하는 시스템콜은 `mkdir`이나 `mkdirat`이다. 해당 경로로 grep을 돌려봤다.

```bash
grep "cmaf" /tmp/strace.* | grep mkdirat
```

성공 케이스

```
/tmp/strace.180:09:23:45.100123 mkdirat(AT_FDCWD, "/tmp/output", 0755) = 0
```

스레드 하나에서 디렉토리 생성하고, 반환값 0으로 성공. 정상적인 흐름이다.

실패 케이스

```
/tmp/strace.177:09:23:45.100234 mkdirat(AT_FDCWD, "/tmp/output", 0755) = 0
/tmp/strace.176:09:23:45.100242 mkdirat(AT_FDCWD, "/tmp/output", 0755) = -1 EEXIST (File exists)
```

두 스레드가 거의 동시에(타임스탬프를 보면 8마이크로초 차이로)같은 디렉토리를 만들려고 시도했다. 스레드 177은 성공했고, 스레드 176은 EEXIST(이미 존재함)로 실패했다. 근데..? EEXIST는 "이미 있다"는 뜻이니까, 그냥 있는 디렉토리를 쓰면 되는 거 아닌가 싶었다

## shaka packager 소스 확인

디렉터리 생성 시도에서 실패했다는게 확실해졌으니 [소스](https://github.com/shaka-project/shaka-packager)를 찾아봤다.

```cpp
// packager/file/local_file.cc
bool LocalFile::Open() {
  std::error_code ec;
  auto file_path = std::filesystem::u8path(file_name_);

  if (file_mode_.find("w") != std::string::npos) {
    if (!std::filesystem::create_directories(file_path.parent_path(), ec) && !ec) {
      LOG(ERROR) << "Failed to create directory";
      return false;
    }
  }
  // ...
}
```

이 부분이 디렉터리를 생성하는 코드로 보인다.

```cpp
if (!std::filesystem::create_directories(..., ec) && !ec) {
```

[`std::filesystem::create_directories`](https://en.cppreference.com/w/cpp/filesystem/create_directories) 문서를 보면 반환값에 대해 이렇게 설명되어 있다

> Returns true if a directory was newly created for the directory p resolves to, false otherwise.

디렉토리를 새로 만들면 `true`, 아니면 `false`를 반환한다. "아니면"이 이미 존재하는 경우인지 에러인 경우인지가 헷갈렸는데 아래 코드로 정확하게 확인했다.

<details>
<summary><code>create_directories</code> 동작 테스트 코드</summary>

```cpp
#include <filesystem>
#include <iostream>
#include <fstream>
#include <system_error>

int main() {
    std::error_code ec;

    // 1. 새 디렉토리 생성
    std::filesystem::remove_all("/tmp/test_dir");
    bool result1 = std::filesystem::create_directories("/tmp/test_dir", ec);
    std::cout<<"New dir - result: "<<result1<<", ec: "<< ec.value()<<" ("<<ec.message()<<")\n";

    // 2. 이미 존재하는 디렉토리
    ec.clear();
    bool result2 = std::filesystem::create_directories("/tmp/test_dir", ec);
    std::cout<<"Exists  - result: "<<result2<<", ec: "<<ec.value()<<" ("<<ec.message()<<")\n";

    // 3. 실제 에러 (파일이 이미 존재하는 경로에 디렉토리 생성 시도)
    { std::ofstream f("/tmp/test_file"); }
    ec.clear();
    bool result3 = std::filesystem::create_directories("/tmp/test_file/subdir", ec);
    std::cout<<"Error  - result: "<<result3<<", ec: "<<ec.value()<<" ("<<ec.message()<<")\n";

    std::filesystem::remove_all("/tmp/test_dir");
    std::filesystem::remove("/tmp/test_file");
    return 0;
}
```

실행 결과

```
New dir - result: 1, ec: 0 (Success)           // 새로 생성됨
Exists  - result: 0, ec: 0 (Success)           // 이미 존재 → false, ec 비어있음
Error   - result: 0, ec: 20 (Not a directory)  // 실제 에러
```

</details>

정리하면,

- 디렉토리를 새로 만들면 `true` 반환
- 디렉토리가 이미 있으면 `false` 반환, `ec`는 비어있음 (에러가 아님)
- 실제 에러가 발생하면 `false` 반환, `ec`에 에러 코드가 설정됨

문제는 디렉토리가 이미 있는 경우의 처리이다. 이 경우는

- 반환값: `false` (새로 만들지 않았으니까)
- `ec`: 비어있음 (에러 상황이 아니니까)
- 조건 평가: `!false && !empty` = `true && true` = `true`
- 결과: 에러로 처리되어 `return false`

디렉토리가 이미 존재하는 정상적인 상황을 에러로 처리하고 있었다.

## 결론

이제 문제 원인을 설명할 수 있다. 스레드 실행 흐름을 재구성해보면,

스레드 A

1. `/tmp/output` 디렉토리 생성 시도
2. `mkdirat` 시스템콜 → 성공 (반환값 0)
3. `create_directories` → `true` 반환
4. 조건: `!true && ...` = `false` → if문 통과, 정상 진행
5. 파일 생성 성공

스레드 B (A과 거의 동시에 실행)

1. `/tmp/output` 디렉토리 생성 시도
2. `mkdirat` 시스템콜 → 실패 (EEXIST, 177이 이미 만들어서)
3. `create_directories` → `false` 반환 (에러는 아니고 "이미 있음"을 의미)
4. `ec`: 비어있음 (EEXIST는 에러로 취급되지 않음)
5. 조건: `!false && !empty` = `true` → 에러로 처리
6. `Open()` 함수가 `false` 반환
7. 파일 열기 시도조차 안 함 → 실패

두 스레드가 거의 동시에 `mkdirat`를 호출할 때만 문제가 생기기 때문에 버그가 간헐적으로만 발생하는 이유도 설명된다. 타이밍이 조금만 달라서 한 스레드가 디렉토리 생성을 완전히 끝낸 후에 다른 스레드가 시작하면, 두 번째 스레드는 `create_directories` 내부에서 "디렉토리가 이미 있네"하고 일찍 리턴해버려서 문제가 없다.

성공 케이스의 strace 로그를 다시 보니 `mkdirat` 호출이 한 스레드에서만 나왔다. 다른 스레드들은 디렉토리 존재 여부를 체크하는 단계에서 "이미 있음"을 확인하고, 시스템콜까지 가지 않은 것이다.

근본적인 해결은 shaka-packager 조건문을 고치는 것이고, 당장 쓰는 입장에서는 패키저 실행 전에 디렉토리를 미리 만들어두는 우회책을 사용할 수 있겠다. 디렉토리가 이미 있으면 `create_directories` 내부에서 시스템콜을 부르기도 전에 리턴하기 때문에, race condition이 발생할 타이밍 자체가 없어진다.

## 마무리

이번 디버깅을 통해 strace가 꽤 유용한 도구라는 걸 새삼 느꼈다.

이번에 썼던 디버깅 순서를 정리해보면:

1. 에러 메시지에서 키워드(파일명 등)를 추출한다
2. strace 로그에서 해당 키워드와 실패(`= -1`)를 grep으로 찾는다
3. 성공 케이스와 실패 케이스의 로그를 비교한다
4. 타임스탬프를 보고 동시성 문제인지 확인한다
5. 의심되는 부분의 소스 코드에서 처리 로직을 확인한다

소스에 대한 이해가 낮은 상황에서 strace 로그만으로 "두 스레드가 동시에 디렉토리를 만들려다가 한쪽이 실패하고, 그 후에 파일 열기도 실패한다"는 것까지 파악할 수 있었다. 소스를 못 봤어도 거기서 우회책(디렉토리 미리 생성)을 떠올리는 건 어렵지 않았을 것이다.

시스템콜은 애플리케이션과 커널 사이의 인터페이스니까, 코드를 몰라도 프로그램이 실제로 뭘 하는지 들여다볼 수 있는 창구가 되는 것 같다는 생각이 들었다.

---

## 참고

- <https://man7.org/linux/man-pages/man1/strace.1.html>
- <https://github.com/shaka-project/shaka-packager>
- <https://en.cppreference.com/w/cpp/filesystem/create_directories>
