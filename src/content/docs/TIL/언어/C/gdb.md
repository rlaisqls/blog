---
title: "gdb"
lastUpdated: 2026-09-13T14:02:48
---

gdb(GNU Debugger)는 실행 중인 프로그램을 멈추고 그 시점의 변수, 메모리, 콜 스택, 레지스터를 들여다볼 수 있게 해주는 디버거다. printf 디버깅과 달리 프로그램을 다시 컴파일하지 않고도 원하는 위치에서 멈춰 상태를 확인하고, 값을 바꿔서 이어 실행하거나, 이미 죽은 프로세스가 남긴 코어 파일을 사후 분석할 수 있다.

이 문서의 출력은 Ubuntu 24.04(aarch64)의 gcc 13.3 / gdb 15.1 환경에서 실제로 실행한 결과다. macOS는 gdb 대신 lldb가 기본이고, Apple Silicon에서 gdb를 쓰려면 Docker 등 리눅스 환경이 필요하다.

## 준비: `-g`로 컴파일

gdb가 소스 라인, 변수 이름, 타입을 알려면 실행 파일에 디버그 정보(DWARF)가 들어 있어야 한다. `-g`를 붙여 컴파일하고, 최적화는 `-O0`로 끄는 것이 좋다. 최적화가 켜지면 변수가 레지스터에만 있거나 사라져서 `<optimized out>`으로 보이고, 인라인 때문에 스택 프레임이 소스와 맞지 않게 된다.

```sh
gcc -g -O0 -o sum sum.c
```

`-g` 없이 `-O2`로 빌드한 바이너리를 gdb로 열면 함수 이름 정도만 남고 어느 줄에서 죽었는지는 알 수 없다.

```
Program received signal SIGSEGV, Segmentation fault.
0x0000aaaae3d30718 in main ()
```

아래 예제 프로그램은 연결 리스트의 합을 구하는데, 두 번째 리스트의 마지막 `next`를 일부러 `0x10`이라는 잘못된 주소로 덮어써서 세그폴트가 나게 만들었다.

```c
#include <stdio.h>
#include <stdlib.h>

struct node {
    int value;
    struct node *next;
};

int sum_list(struct node *head) {
    int total = 0;
    for (struct node *cur = head; cur != NULL; cur = cur->next) {
        total += cur->value;
    }
    return total;
}

struct node *make_list(int n) {
    struct node *head = NULL;
    for (int i = n; i > 0; i--) {
        struct node *node = malloc(sizeof(struct node));
        node->value = i;
        node->next = head;
        head = node;
    }
    return head;
}

int main(void) {
    struct node *list = make_list(3);
    printf("sum = %d\n", sum_list(list));

    struct node *broken = make_list(2);
    broken->next->next = (struct node *)0x10;  /* 잘못된 포인터 */
    printf("sum = %d\n", sum_list(broken));
    return 0;
}
```

## 시작과 종료

```sh
gdb ./sum              # 실행 파일 로드
gdb -q ./sum           # 시작 배너 생략
gdb --args ./sum a b   # 프로그램 인자를 함께 지정
gdb -p <pid>           # 실행 중인 프로세스에 attach
gdb ./sum ./core       # 코어 파일 분석
```

gdb 프롬프트 안에서는 `run`(`r`)으로 프로그램을 시작하고, `run arg1 arg2`처럼 인자를 줄 수도 있다. `quit`(`q`)으로 나간다. 대부분의 명령은 앞글자 약어가 있고, 빈 줄에서 Enter를 치면 직전 명령을 반복한다. `help <명령>`으로 사용법을 볼 수 있다.

## 크래시 지점 찾기: `run`과 `bt`

가장 기본적인 사용법은 그냥 실행해서 죽는 곳을 보는 것이다. 세그폴트가 나면 gdb가 프로그램을 멈추고 시그널을 받은 위치를 보여준다.

```
(gdb) run
sum = 6

Program received signal SIGSEGV, Segmentation fault.
0x0000aaaad60107f4 in sum_list (head=0xaaaae971a330) at sum.c:12
12	        total += cur->value;
```

`bt`(backtrace)는 현재 콜 스택을 출력한다. `#0`이 현재 프레임이고 번호가 커질수록 호출자 쪽이다.

```
(gdb) bt
#0  0x0000aaaad60107f4 in sum_list (head=0xaaaae971a330) at sum.c:12
#1  0x0000aaaad60108e4 in main () at sum.c:34
```

`cur->value`를 읽다 죽었으니 `cur`를 확인해보면 바로 원인이 보인다.

```
(gdb) print cur
$1 = (struct node *) 0x10
(gdb) print *cur
Cannot access memory at address 0x10
```

어떤 주소에 접근하다 죽었는지는 `$_siginfo` 편의 변수로도 확인할 수 있다.

```
(gdb) print $_siginfo._sifields._sigfault.si_addr
$11 = (void *) 0x10
```

호출자 쪽 프레임으로 올라가려면 `up`, 내려오려면 `down`, 특정 번호로 가려면 `frame N`(`f N`)을 쓴다. 프레임을 바꾸면 `print`가 참조하는 지역 변수 스코프도 그 프레임으로 바뀐다.

## 중단점: `break`

`break`(`b`)는 함수 이름, `파일:줄번호`, `*주소` 를 받는다.

```
(gdb) break sum_list
Breakpoint 1 at 0x7e0: file sum.c, line 10.
(gdb) break sum.c:33
Breakpoint 2 at 0x8cc: file sum.c, line 33.
```

`if` 조건을 붙이면 조건이 참일 때만 멈춘다. 반복문 안에서 특정 회차만 잡을 때 유용하다. 조건식에 쓰이는 변수는 그 위치에서 보이는 스코프에 있어야 한다. 예를 들어 `break make_list if i == 2`는 함수 진입 시점에 `i`가 아직 선언되지 않아 `No symbol "i" in current context` 오류가 나므로, 반복문 안의 줄을 지정해야 한다.

```
(gdb) break sum.c:20 if i == 2
Breakpoint 1 at 0x844: file sum.c, line 20.
(gdb) run

Breakpoint 1, make_list (n=3) at sum.c:20
20	        struct node *node = malloc(sizeof(struct node));
(gdb) print i
$1 = 2
```

- `tbreak`: 한 번 멈추면 자동으로 삭제되는 임시 중단점
- `info breakpoints`(`i b`): 중단점 목록과 각각 몇 번 걸렸는지 표시
- `delete N`: 삭제. 번호 없이 `delete`면 전부 삭제
- `disable N` / `enable N`: 삭제하지 않고 끄기/켜기

```
(gdb) info breakpoints
Num     Type           Disp Enb Address            What
1       breakpoint     keep y   0x0000aaaaac7a07e0 in sum_list at sum.c:10
	breakpoint already hit 1 time
2       hw watchpoint  keep y                      total
	breakpoint already hit 3 times
```

## 실행 제어

| 명령 | 약어 | 동작 |
|---|---|---|
| `continue` | `c` | 다음 중단점까지 계속 실행 |
| `next` | `n` | 한 줄 실행. 함수 호출은 안으로 들어가지 않고 통과 |
| `step` | `s` | 한 줄 실행. 함수 호출이면 그 안으로 들어감 |
| `finish` | `fin` | 현재 함수가 리턴할 때까지 실행하고 반환값 출력 |
| `until` | `u` | `next`와 같지만 반복문의 뒤쪽으로 점프할 때는 루프를 빠져나갈 때까지 실행 |
| `advance 위치` | | 지정 위치까지 실행 (임시 중단점 + continue) |
| `nexti` / `stepi` | `ni` / `si` | 기계어 명령 단위로 한 스텝 |

`finish`는 함수 안에서 나머지를 다 돌리고 반환값을 보여주므로, 함수 결과만 궁금할 때 편하다.

```
(gdb) finish
Run till exit from #0  make_list (n=3) at sum.c:20
0x0000aaaaceff08a4 in main () at sum.c:29
29	    struct node *list = make_list(3);
Value returned is $4 = (struct node *) 0xaaaad4e932e0
```

## 값 확인: `print`, `x`, `display`

`print`(`p`)는 C 표현식을 평가한다. 구조체는 필드 단위로 펼쳐 보여주고, 포인터 역참조, 산술, 함수 호출도 가능하다. 결과는 `$1`, `$2`처럼 번호가 붙어 나중에 다시 참조할 수 있다.

```
(gdb) print *broken
$1 = {value = 1, next = 0xaaaaf2469310}
(gdb) print *broken->next
$2 = {value = 2, next = 0x0}
(gdb) print broken->next->value + 10
$7 = 12
(gdb) print sizeof(struct node)
$5 = 16
(gdb) print &broken->next
$6 = (struct node **) 0xaaaaf2469338
```

`print/포맷`으로 출력 형식을 바꾼다. `/x` 16진수, `/d` 10진수, `/t` 2진수, `/c` 문자, `/a` 주소+심볼, `/s` 문자열이다.

```
(gdb) print/x broken->value
$4 = 0x1
```

배열이 포인터로만 잡혀 있을 때는 `p *ptr@N`으로 N개를 배열처럼 볼 수 있다. (`p *arr@5`)

**`call`** 로 프로그램 안의 함수를 직접 호출해볼 수 있다. 멈춘 상태에서 함수의 동작을 확인하거나, 사용자 정의 dump 함수를 부를 때 쓴다.

```
(gdb) call sum_list(broken)
$8 = 3
```

### `x`: 메모리 직접 보기

`x/[개수][포맷][크기] 주소` 형태다. 포맷은 `print`와 같고, 크기는 `b`(1바이트), `h`(2), `w`(4), `g`(8)이다. 구조체가 실제 메모리에 어떻게 놓여 있는지 볼 때 유용하다.

```
(gdb) x/4xw broken
0xaaaaf2469330:	0x00000001	0x00000000	0xf2469310	0x0000aaaa
(gdb) x/2gx broken
0xaaaaf2469330:	0x0000000000000001	0x0000aaaaf2469310
```

첫 4바이트가 `value = 1`, 그 뒤 4바이트는 8바이트 정렬을 위한 패딩(0), 마지막 8바이트가 `next` 포인터임을 알 수 있다. `sizeof(struct node)`가 12가 아니라 16인 이유가 여기서 보인다. 리틀 엔디언이라 워드 단위로 보면 포인터 `0x0000aaaaf2469310`이 `0xf2469310 0x0000aaaa` 순서로 나뉘어 보인다.

`x/i`는 메모리를 기계어로 해석해 보여준다. `x/3i $pc`는 현재 위치부터 3개 명령을 출력한다.

### `display`: 멈출 때마다 자동 출력

`display 표현식`을 등록하면 이후 `next`, `step`, 중단점으로 멈출 때마다 값을 함께 찍어준다. 반복문을 따라가며 특정 변수를 계속 지켜볼 때 `print`를 매번 치지 않아도 된다.

```
(gdb) display cur->value
(gdb) display/x total
(gdb) next
12	        total += cur->value;
1: cur->value = 2
2: /x total = 0x63
```

`info display`로 목록을 보고 `undisplay N`으로 지운다.

### 타입 확인: `ptype`, `whatis`

```
(gdb) ptype struct node
type = struct node {
    int value;
    struct node *next;
}
(gdb) whatis broken
type = struct node *
(gdb) whatis broken->value
type = int
```

`ptype`은 구조체 정의를 펼쳐서 보여주고, `whatis`는 타입 이름만 알려준다.

### 스코프 안 변수 한번에

- `info locals`: 현재 프레임의 지역 변수 전부
- `info args`: 현재 함수의 인자 전부
- `info frame`: 프레임 주소, 저장된 pc, 저장된 레지스터 위치 등 프레임 메타 정보

```
(gdb) info locals
node = 0xaaaad4e932a0
i = 2
head = 0xaaaad4e932a0
```

## 값 변경: `set var`

멈춘 상태에서 변수 값을 바꾸고 계속 실행할 수 있다. 특정 분기를 강제로 타보거나, 버그 수정 효과를 재컴파일 없이 미리 확인할 때 쓴다.

```
(gdb) set var broken->value = 99
(gdb) print *broken
$10 = {value = 99, next = 0xaaaaf2469310}
```

`print broken->value = 99`처럼 `print`에 대입식을 넘겨도 같은 효과다. `set var`를 쓰는 이유는 gdb 자체 설정 명령(`set width` 등)과 이름이 겹치는 변수를 다룰 때 혼동을 피하기 위해서다.

## 감시점: `watch`

`watch 표현식`은 그 값이 바뀔 때마다 멈춘다. "이 변수를 누가 언제 바꾸는가"를 찾을 때 쓴다. 하드웨어 디버그 레지스터를 이용하므로 실행 속도에 거의 영향이 없고, 개수 제한(보통 4개)이 있다.

```
(gdb) break sum_list
(gdb) run
Breakpoint 1, sum_list (head=0xaaaaeaea42e0) at sum.c:10
10	    int total = 0;
(gdb) watch total
Hardware watchpoint 2: total
(gdb) continue

Hardware watchpoint 2: total

Old value = 43690
New value = 0
sum_list (head=0xaaaaeaea42e0) at sum.c:11
(gdb) continue

Hardware watchpoint 2: total

Old value = 0
New value = 1
```

첫 번째 멈춤에서 Old value가 43690(0xAAAA)인 것은 초기화 전 스택에 남아 있던 쓰레기 값이다. 지역 변수에 걸어둔 감시점은 그 함수가 리턴하며 스코프를 벗어나면 자동으로 삭제된다.

- `rwatch`: 읽을 때 멈춤
- `awatch`: 읽거나 쓸 때 멈춤
- `watch -l 표현식`: 표현식이 가리키는 주소 자체를 감시. 포인터 변수가 바뀌어도 원래 주소를 계속 본다.

## 소스와 어셈블리

`list`(`l`)는 소스를 보여준다. 함수 이름, 줄 번호, `시작,끝` 범위를 받고, 인자 없이 반복하면 이어서 보여준다.

```
(gdb) list 29,34
29	    struct node *list = make_list(3);
30	    printf("sum = %d\n", sum_list(list));
31
32	    struct node *broken = make_list(2);
33	    broken->next->next = (struct node *)0x10;  /* 잘못된 포인터 */
34	    printf("sum = %d\n", sum_list(broken));
```

`disassemble`은 함수의 기계어를 보여주고, `/s`를 붙이면 소스 줄과 섞어서 보여준다. `-O0`에서 `total += cur->value`가 어떻게 컴파일되는지 볼 수 있다.

```
(gdb) disassemble /s sum_list
12	        total += cur->value;
   0x0000aaaac41c07f0 <+24>:	ldr	x0, [sp, #24]
   0x0000aaaac41c07f4 <+28>:	ldr	w0, [x0]
   0x0000aaaac41c07f8 <+32>:	ldr	w1, [sp, #20]
   0x0000aaaac41c07fc <+36>:	add	w0, w1, w0
   0x0000aaaac41c0800 <+40>:	str	w0, [sp, #20]
```

세그폴트가 난 주소 `...07f4`가 `ldr w0, [x0]`, 즉 `cur`(x0 = 0x10)가 가리키는 곳을 읽는 명령임을 확인할 수 있다.

레지스터는 `info registers`(`i r`)로 보고, 표현식 안에서는 `$pc`, `$sp`처럼 `$`를 붙여 쓴다. x86-64에서는 `$rip`, `$rsp`, `$rax` 등이고 aarch64에서는 `$pc`, `$sp`, `$x0`~`$x30`이다. 아키텍처 무관하게 `$pc`, `$sp`, `$fp`는 항상 쓸 수 있다.

```
(gdb) info registers pc sp
pc             0xaaaac41c089c      0xaaaac41c089c <main+8>
sp             0xfffff0109320      0xfffff0109320
(gdb) x/3i $pc
=> 0xaaaac41c089c <main+8>:	mov	w0, #0x3
   0xaaaac41c08a0 <main+12>:	bl	0xaaaac41c0828 <make_list>
   0xaaaac41c08a4 <main+16>:	str	x0, [sp, #16]
```

`layout src`, `layout asm`, `layout split`으로 TUI 모드를 켜면 소스나 어셈블리 창이 위에 고정된 상태로 명령을 칠 수 있다. `Ctrl-x a`로 토글한다.

## 코어 파일 분석

프로그램이 운영 환경에서 죽었을 때 재현 없이 원인을 찾으려면 코어 덤프를 쓴다. `ulimit -c unlimited`로 코어 생성을 허용하면 크래시 시점의 메모리와 레지스터가 파일로 남는다. 저장 위치와 이름은 `/proc/sys/kernel/core_pattern`을 따르며, systemd 배포판에서는 `coredumpctl`이 관리하는 경우가 많다.

```sh
$ ulimit -c unlimited
$ ./sum
sum = 6
Segmentation fault (core dumped)
$ gdb -q ./sum ./core
```

```
Core was generated by `./sum'.
Program terminated with signal SIGSEGV, Segmentation fault.
#0  0x0000aaaae71f07f4 in sum_list (head=0xaaab039bb330) at sum.c:12
12	        total += cur->value;
(gdb) bt
#0  0x0000aaaae71f07f4 in sum_list (head=0xaaab039bb330) at sum.c:12
#1  0x0000aaaae71f08e4 in main () at sum.c:34
(gdb) print cur
$1 = (struct node *) 0x10
(gdb) print *head
$3 = {value = 1, next = 0xaaab039bb310}
```

실행 중인 프로세스와 달리 `continue`나 `call`은 할 수 없지만, `bt`, `print`, `x`, `frame` 같은 조회 명령은 전부 그대로 쓸 수 있다. 코어를 만든 바이너리와 정확히 같은 빌드(디버그 정보 포함)를 넘겨야 심볼이 맞는다.

## 실행 중인 프로세스에 붙기

`gdb -p <pid>` 또는 gdb 안에서 `attach <pid>`로 이미 돌고 있는 프로세스를 멈추고 들여다볼 수 있다. 붙는 순간 프로세스는 정지하고, `detach`하면 다시 돌아간다.

```
$ gdb -q -p 73
0x0000ffffbebfbd0c in __GI___clock_nanosleep (...) at ../sysdeps/unix/sysv/linux/clock_nanosleep.c:78
(gdb) bt
#0  0x0000ffffbebfbd0c in __GI___clock_nanosleep (...)
#1  0x0000ffffbec060bc in __GI___nanosleep (...)
#2  0x0000ffffbec1616c in __sleep (seconds=0) at ../sysdeps/posix/sleep.c:55
#3  0x0000aaaadccd0784 in main () at loop.c:4
(gdb) print counter
$1 = 3
(gdb) set var counter = 100
(gdb) detach
[Inferior 1 (process 73) detached]
```

`sleep` 중이던 프로세스라 libc 내부에서 멈춰 있고, `#3`에서야 사용자 코드가 나온다. libc 소스는 없어서 경고가 나지만 심볼만으로도 어디에 있는지는 알 수 있다. 리눅스에서는 `ptrace_scope` 설정에 따라 같은 사용자의 프로세스라도 attach가 막힐 수 있는데, 이때는 root로 실행하거나 `/proc/sys/kernel/yama/ptrace_scope`를 0으로 바꿔야 한다.

## 자주 쓰는 설정과 자동화

- `set print pretty on`: 구조체를 필드마다 줄바꿈해서 출력. 중첩 구조체가 많으면 필수
- `set pagination off`: `---Type <return> to continue---` 멈춤 제거
- `set confirm off`: `quit`, `delete` 등의 확인 질문 제거
- `set disassembly-flavor intel`: x86에서 AT&T 대신 Intel 문법으로 어셈블리 표시
- `set var`와 `set` 계열 설정을 `~/.gdbinit`에 적어두면 매번 적용된다.

`-x 파일`이나 `-ex 명령`으로 명령을 미리 넘기고 `-batch`를 붙이면 대화형 프롬프트 없이 결과만 출력하고 종료한다. 이 문서의 출력도 이 방식으로 뽑았다. CI에서 크래시 시 자동으로 백트레이스를 남기거나, 같은 디버깅 절차를 반복할 때 유용하다.

```sh
gdb -q -batch -ex run -ex bt ./sum
gdb -q -batch -x commands.gdb ./sum
```

중단점에 도달할 때 자동으로 실행할 명령도 붙일 수 있다.

```
(gdb) break sum.c:12
(gdb) commands
> silent
> print cur->value
> continue
> end
```

이렇게 하면 12번 줄을 지날 때마다 값만 찍고 멈추지 않고 넘어가서, 코드를 건드리지 않는 printf 디버깅처럼 쓸 수 있다.

## 명령 요약

| 분류 | 명령 |
|---|---|
| 시작/종료 | `run`, `start`(main에서 멈춤), `quit`, `attach`, `detach`, `kill` |
| 중단점 | `break`, `tbreak`, `watch`, `rwatch`, `awatch`, `info breakpoints`, `delete`, `disable`, `enable`, `condition N 식` |
| 실행 | `continue`, `next`, `step`, `finish`, `until`, `advance`, `nexti`, `stepi` |
| 스택 | `bt`, `bt full`(지역 변수 포함), `frame`, `up`, `down`, `info frame`, `info locals`, `info args` |
| 값 | `print`, `print/x`, `x/Nfu`, `display`, `undisplay`, `ptype`, `whatis`, `set var`, `call` |
| 코드 | `list`, `disassemble`, `info line`, `info registers`, `layout` |
| 기타 | `info sharedlibrary`, `info signals`, `info threads`, `thread N`, `help` |

---
참고

- <https://sourceware.org/gdb/current/onlinedocs/gdb.html/>
- <https://sourceware.org/gdb/documentation/>
- <https://beej.us/guide/bggdb/>
