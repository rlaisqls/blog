---
title: strace로 shaka-packager의 간헐적 실패 버그 추적하기
lastUpdated: 2025-12-05T00:00:00
tags: ["strace", "System Call", "debugging"]
---

## 문제 상황

저희 팀에서는 [shaka-packager](https://github.com/shaka-project/shaka-packager) CLI를 사용해 여러 해상도의 영상을 동시에 패키징하는 작업을 진행하고 있었습니다. 그런데 어느 날부터 일부 스레드에서 간헐적으로 패키징이 실패하는 현상이 발생했어요.

문제가 까다로웠던 이유는 **재현이 일정하지 않다는 점**이었습니다. 대부분 2개 파일까지는 잘 처리되다가 마지막 파일에서 실패하고, 재시도하면 성공하기도 하는 그런 패턴이었어요.

```
1.mp4 처리 시작
2.mp4 처리 시작
3.mp4 처리 시작
2.mp4 출력 파일 생성 완료
1.mp4 출력 파일 생성 완료
3.mp4 출력 파일 생성 실패: Packaging Error: 5 (FILE_FAILURE) - Cannot open file to write
```

에러 코드 5번 `FILE_FAILURE`는 shaka-packager에서 파일 관련 작업이 실패했을 때 반환하는 코드인데, 로그만 봐서는 정확한 원인을 알 수가 없었습니다.

## 원인을 찾기 위한 가설 검증

일단 떠오르는 가설들을 하나씩 검증해봤습니다.

| 가설 | 검증 결과 |
|------|----------|
| 패키저 버전 문제 | 여러 버전에서 동일하게 발생 |
| 특정 영상 파일 문제 | 같은 영상도 재시도 시 성공 |
| 디스크/메모리 부족 | 충분한 여유 공간 확인 |
| 파일 디스크립터 부족 | 15개 이하로 사용 중 |
| 입력 파일 개수 | **1개일 때는 항상 성공, 여러 개일 때만 실패** |

마지막 항목이 힌트가 되었습니다. 동시에 여러 파일을 처리할 때만 실패한다면, **동시성 문제**일 가능성이 높았어요.

## strace를 활용한 시스템콜 추적

더 이상 애플리케이션 레벨 로그로는 원인을 파악하기 어려워서, 시스템콜을 직접 추적해보기로 했습니다.

> **strace란?**
>
> 프로세스가 호출하는 시스템콜을 추적하는 Linux 도구입니다. 프로세스가 커널에 요청하는 모든 작업(파일 열기, 읽기, 쓰기, 네트워크 통신 등)을 실시간으로 확인할 수 있어요. 애플리케이션 코드를 모르더라도 프로그램이 실제로 어떤 동작을 하는지 저수준에서 파악할 때 매우 유용합니다.

다음 명령어로 strace를 실행했습니다.

```bash
strace -ff -tt -y -i -o /tmp/strace ./packager ...
```

각 옵션의 의미는 다음과 같아요.

| 옵션 | 설명 |
|------|------|
| `-ff` | 자식 프로세스/스레드도 추적하고, 각각 별도 파일로 저장 |
| `-tt` | 마이크로초 단위 타임스탬프 기록 (동시성 문제 분석에 필수) |
| `-y` | 파일 디스크립터 대신 실제 파일 경로 표시 |
| `-i` | 명령어 포인터 주소 기록 |
| `-o /tmp/strace` | 출력 경로 (스레드별로 `/tmp/strace.12345` 형태로 저장) |

성공 케이스와 실패 케이스 모두 로그를 남겨두고 비교 분석을 진행했습니다.

## 에러 지점 확인

실패한 파일명으로 에러를 검색해봤습니다. 시스템콜이 실패하면 반환값이 `-1`이고 뒤에 에러 코드가 붙습니다.

```bash
grep "3.mp4" /tmp/strace.* | grep "= -1"
```

결과는 다음과 같았어요.

```
/tmp/strace.176:09:23:45.123456 openat(AT_FDCWD, "/tmp/output/3.mp4", O_WRONLY|O_CREAT|O_TRUNC, 0666) = -1 ENOENT (No such file or directory)
```

`openat` 시스템콜이 `ENOENT`로 실패했습니다. `O_CREAT` 플래그가 있으면 파일이 없을 때 새로 만드는데, 왜 `ENOENT`가 발생했을까요?

[man 페이지](https://man7.org/linux/man-pages/man2/openat.2.html)를 확인해보니 이런 내용이 있었습니다.

> ENOENT: A directory component in pathname does not exist or is a dangling symbolic link.

**상위 디렉토리가 없으면 ENOENT가 발생**한다는 것이었어요.

## 디렉토리 생성 타이밍 분석

디렉토리 생성과 관련이 있다면, `mkdir` 또는 `mkdirat` 시스템콜을 확인해봐야 했습니다.

```bash
grep "output" /tmp/strace.* | grep mkdirat
```

**성공 케이스**

```
/tmp/strace.180:09:23:45.100123 mkdirat(AT_FDCWD, "/tmp/output", 0755) = 0
```

한 스레드에서만 디렉토리를 생성하고 성공(반환값 0)했습니다.

**실패 케이스**

```
/tmp/strace.177:09:23:45.100234 mkdirat(AT_FDCWD, "/tmp/output", 0755) = 0
/tmp/strace.176:09:23:45.100242 mkdirat(AT_FDCWD, "/tmp/output", 0755) = -1 EEXIST (File exists)
```

두 스레드가 **8마이크로초 차이**로 같은 디렉토리를 생성하려고 시도했습니다. 스레드 177은 성공, 스레드 176은 `EEXIST`(이미 존재함)로 실패했어요.

그런데 `EEXIST`는 "이미 존재한다"는 의미이니까, 그냥 기존 디렉토리를 사용하면 되는 거 아닐까요? 소스 코드를 확인해봐야 했습니다.

## shaka-packager 소스 코드 분석

[shaka-packager 저장소](https://github.com/shaka-project/shaka-packager)에서 디렉토리 생성 코드를 찾아봤습니다.

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

문제가 되는 조건문을 자세히 살펴볼게요.

```cpp
if (!std::filesystem::create_directories(..., ec) && !ec) {
```

[`std::filesystem::create_directories`](https://en.cppreference.com/w/cpp/filesystem/create_directories) 문서에 따르면 반환값은 다음과 같습니다.

> Returns true if a directory was newly created for the directory p resolves to, false otherwise.

정리하면 이렇습니다.

| 상황 | 반환값 | error_code |
|------|--------|------------|
| 디렉토리를 새로 생성 | `true` | 비어있음 |
| 디렉토리가 이미 존재 | `false` | 비어있음 |
| 실제 에러 발생 | `false` | 에러 코드 설정됨 |

문제는 **디렉토리가 이미 존재하는 경우**입니다.

- 반환값: `false` (새로 만들지 않았으니까)
- `ec`: 비어있음 (에러가 아니니까)
- 조건 평가: `!false && !empty` = `true && true` = `true`
- 결과: **에러로 처리되어 `return false`**

정상적인 상황을 에러로 처리하는 버그였습니다.

<details>
<summary>create_directories 동작 검증 코드</summary>

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
    std::cout << "New dir - result: " << result1 << ", ec: " << ec.value() << " (" << ec.message() << ")\n";

    // 2. 이미 존재하는 디렉토리
    ec.clear();
    bool result2 = std::filesystem::create_directories("/tmp/test_dir", ec);
    std::cout << "Exists  - result: " << result2 << ", ec: " << ec.value() << " (" << ec.message() << ")\n";

    // 3. 실제 에러 (파일이 이미 존재하는 경로에 디렉토리 생성 시도)
    { std::ofstream f("/tmp/test_file"); }
    ec.clear();
    bool result3 = std::filesystem::create_directories("/tmp/test_file/subdir", ec);
    std::cout << "Error   - result: " << result3 << ", ec: " << ec.value() << " (" << ec.message() << ")\n";

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

## 버그 발생 메커니즘 정리

이제 전체 그림이 보입니다. 스레드별 실행 흐름을 재구성해볼게요.

**스레드 A (성공)**

1. `/tmp/output` 디렉토리 생성 시도
2. `mkdirat` 시스템콜 → 성공 (반환값 0)
3. `create_directories` → `true` 반환
4. 조건: `!true && ...` = `false` → if문 통과
5. 파일 생성 성공

**스레드 B (실패, A와 거의 동시 실행)**

1. `/tmp/output` 디렉토리 생성 시도
2. `mkdirat` 시스템콜 → 실패 (EEXIST, A가 이미 생성)
3. `create_directories` → `false` 반환 (에러 아님, "이미 있음" 의미)
4. `ec`: 비어있음
5. 조건: `!false && !empty` = `true` → **에러로 잘못 처리**
6. `Open()` 함수가 `false` 반환
7. 파일 열기 시도조차 하지 않음 → 실패

버그가 **간헐적으로만 발생**하는 이유도 설명됩니다. 두 스레드가 정확히 같은 타이밍에 `mkdirat`를 호출해야만 문제가 생기기 때문이에요. 타이밍이 조금만 달라서 한 스레드가 디렉토리 생성을 완료한 후에 다른 스레드가 시작하면, 두 번째 스레드는 `create_directories` 내부에서 "이미 있네"하고 시스템콜 전에 리턴해버립니다.

## 해결 방법

**근본적 해결**: shaka-packager의 조건문 수정이 필요합니다.

```cpp
// 수정 전
if (!std::filesystem::create_directories(..., ec) && !ec) {

// 수정 후 (에러 코드가 설정된 경우에만 실패 처리)
if (ec) {
```

**당장의 우회책**: 패키저 실행 전에 디렉토리를 미리 생성해두면 됩니다.

```bash
mkdir -p /tmp/output
./packager ...
```

디렉토리가 이미 존재하면 `create_directories` 내부에서 시스템콜을 호출하기 전에 리턴하기 때문에, race condition이 발생할 타이밍 자체가 없어집니다.

## 마무리

이번 디버깅을 통해 strace가 정말 유용한 도구라는 걸 다시 한번 느꼈습니다. 특히 간헐적으로 발생하는 버그는 코드만 봐서는 원인을 찾기 어려운 경우가 많은데, 시스템콜 레벨에서 실제로 무슨 일이 일어나는지 보면 의외로 빠르게 실마리가 잡히기도 해요.

**strace 디버깅 순서 정리**

1. 에러 메시지에서 키워드(파일명 등) 추출
2. strace 로그에서 해당 키워드와 실패(`= -1`) 검색
3. 성공/실패 케이스 로그 비교
4. 타임스탬프로 동시성 문제 여부 확인
5. 의심 지점의 소스 코드에서 처리 로직 확인

소스 코드에 대한 이해가 없는 상태에서도 strace 로그만으로 "두 스레드가 동시에 디렉토리를 만들려다가 한쪽이 실패하고, 그 후에 파일 열기도 실패한다"는 것까지 파악할 수 있었습니다. 여기까지 알면 우회책(디렉토리 미리 생성)을 떠올리는 건 어렵지 않았을 거예요.

시스템콜은 애플리케이션과 커널 사이의 인터페이스이기 때문에, 코드를 몰라도 프로그램이 실제로 뭘 하는지 들여다볼 수 있는 창구가 된다는 점이 인상적이었습니다.

---

## 참고 자료

- [strace man page](https://man7.org/linux/man-pages/man1/strace.1.html)
- [shaka-packager GitHub](https://github.com/shaka-project/shaka-packager)
- [std::filesystem::create_directories - cppreference](https://en.cppreference.com/w/cpp/filesystem/create_directories)
