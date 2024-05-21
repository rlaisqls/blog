---
title: 'eBPF로 서버 성능 Profiling하는 법: Pyroscope의 구현 살펴보기'
lastUpdated: 2024-05-21T19:56:10
tags: ["BPF", "linux"]
---

eBPF를 사용한 모니터링을 공부하며 Pyroscopee의 eBPF 기능에 관심이 생겼다. 구현 코드를 살펴보면서 eBPF를 활용하는 방법과 그에 연관된 Linux 기능을 익힐 수 있었는데, 내용을 되새기기 위해 공부했던 부분을 전체적으로 풀어 설명해보려 한다.

우선 관련된 기술 배경부터 알아보자.

---

### Pyroscope

[Grafana Pyroscope](https://github.com/grafana/pyroscope)는 애플리케이션을 지속적으로 프로파일링하는 오픈소스 플랫폼이다. 

> **프로파일링(profiling)이란?**
>
> 프로그램을 실행하면서 성능을 측정하고, 분석하는 행위를 프로파일링이라고 한다. <br/>
> - 함수 혹은 메소드가 CPU를 얼마나 오랫동안 사용하는가, 얼마나 많이 호출되는가
> - 메모리를 얼마나 자주 할당 및 해제하는가, 얼마나 많이 할당하느냐
> 
> 와 같은 정보를 측정한다.

애플리케이션이 사용한 CPU, Memory 등의 프로파일링 정보를 Flame Graph로 확인할 수 있다.

Flame Graph에서 각 사각형은 Stack frame(함수)를 나타내고 사각형의 가로 너비는 현재 프로파일에 얼마나 존재하는지(실행되는지)를 나타낸다. CPU 사용 정보에 대한 그래프라면, CPU를 오랫동안 사용하는 함수의 너비가 넓게 표시될 것이다. 지나치게 넓게 표시되는 함수가 있다면 그 함수의 CPU 사용을 줄일 방법을 고민해볼 수 있다.

이처럼 Flame Graph를 사용하면 리소스를 많이 사용하는 병목 지점이 어디인지 찾아내 개선할 수 있다.

<img style="width:597px;" alt="image" src="https://github.com/rlaisqls/rlaisqls/assets/81006587/e1e3ba7a-cced-418b-8428-875069021be8"/>

Pyroscope에서 Profiling 정보를 수집하는데는 두 가지 방식이 있다.

1. 각 언어 SDK에서 Pyroscope에 정보를 전송하는 방식 ([문서](https://grafana.com/docs/pyroscope/latest/configure-client/language-sdks/))
2. Grafana Agent(Alloy)에서 Pyroscope에 정보를 전송하는 방식 ([문서](https://grafana.com/docs/pyroscope/latest/configure-client/grafana-agent/))

이 중 Grafana Agent(Alloy) 방식을 쓰면 **eBPF**를 사용해 정보를 수집할 수 있다. 

### eBPF

> **[eBPF](https://ebpf.io/)란?**
>
> 커널 레벨에서 코드를 실행시키기 위한 공간을 제공해주는 기술이다. (in-kernel virtual machine) <br/>
> 커널 코드 내에 미리 정의된 훅이나 kprobe, uprobe, tracepoint를 사용해서 프로그램을 실행할 수 있다. 즉, 특정 이벤트가 발생했을 때 커널 레벨에서 코드를 실행시키도록 할 수 있다. <br/>
> 커널 수준에서 일어나는 특정 이벤트나 정보를 추적하거나 모니터링하기 위해 활용된다.

eBPF를 사용한 Pyroscope의 Profile 정보 수집 기능은 아래와 같은 장점을 가진다:
- 성능 오버헤드가 가장 낮고, low level의 함수 호출 정보(System Call 등)까지 세밀하게 수집할 수 있다.
- 애플리케이션 코드를 수정하지 않고 데이터를 수집할 수 있다.

하지만 한계 또한 있다:
- 일부 언어만 지원된다. <br/> (현재 Go, Rust, C/C++, Python에서 사용 가능하고, Java와 node.js는 [이슈](https://github.com/grafana/pyroscope/issues/2766)만 등록되었다.)
- 메모리 및 Thread Lock 등의 프로파일링 유형을 지원하지 않는다.
- eBPF는 호스트 시스템에 대한 root 액세스 권한이 필요하므로 일부 환경에서 문제가 될 수 있다.

장점과 한계가 확실한 기능이라는 생각이 든다. Grafana Agent(Alloy)에서 eBPF로 Pyroscope Profiling 정보를 수집하는 동작이 어떻게 구현되는지 자세히 살펴보며 특징을 더 이해해보자.

---

## eBPF로 Profiling 정보를 수집하는 과정

### 1. 타겟 프로세스 등록

우선 수집할 대상(Target)을 등록하는 것으로 시작한다. 타겟을 등록하는 이유는 필요한 타겟에 대해서만 Profiling 정보를 수집하고, 수집한 정보에 타겟에 대한 라벨을 붙여 저장하기 위함이다.

Grafana Agent eBPF 모드는 **프로세스**(또는 컨테이너 프로세스)를 기준으로 타겟을 등록한다. 즉, pid를 기준으로 타겟을 구분한다. 아래 코드에서 pid로 타겟을 구분하여 map으로 저장하는 모습을 볼 수 있다.

```go
// https://github.com/grafana/pyroscope/blob/774085f/ebpf/sd/target.go#L210C1-L222C3
func (tf *targetFinder) setTargets(opts TargetsOptions) {
	...
	containerID2Target := make(map[containerID]*Target)
	pid2Target := make(map[uint32]*Target)

	for _, target := range opts.Targets {
		if pid := pidFromTarget(target); pid != 0 {
			t := NewTarget("", pid, target)
			pid2Target[pid] = t
		}
    ...
	}
}
```

타겟은 Grafana Agent의 설정 파일로 지정할 수 있다. 프로세스별로 등록할 수도 있고, 특정 컨테이너나 K8s Pod 단위로 등록할 수도 있다. 프로세스를 기준으로 한다는 점은 동일하지만 붙는 라벨의 종류가 다르다. <br>
<span style="color: #888888">(e.g. 컨테이너라면 컨테이너 이름, k8s Pod라면 네임스페이스, 노드 등의 라벨이 추가로 붙는다.)</span>

자세한 설정 방법은 [이 문서](https://grafana.com/docs/alloy/latest/reference/components/)에서 discovery로 시작하는 항목을 참고하면 된다. 이 글에서는 Target 등록 방식은 자세히 다루지 않고, **프로세스를 기준으로 수집 대상을 지정**한다는 것만 짚고 넘어간다.

### 2. 프로세스별 타입 저장

Grafana Agent eBPF 모드는 CPU에서 명령어(함수)가 실행되었을 때 eBPF 코드를 통해 "**어떤 프로세스에서 어떤 명령어가 실행되었다!**"라는 내용의 이벤트를 받고 커널에서 정보를 가져와 해석한다. 이벤트를 받으면 해당 프로세스가 타겟으로 등록되었는지, 그리고 어떤 방식으로 해석해야하는 프로세스인지를 기준으로 다르게 처리한다. (`PYTHON` 타입과 `FRAMEPOINTER` 타입이 있다. 다음 단계에서 자세히 설명한다.)

두 조건을 확인하기 위해선 에이전트 서버의 타겟 정보와 `/proc/{PID}` 위치의 파일을 조회하는 과정이 필요한데, eBPF는 커널 영역에 격리된 공간이기 때문에 **유저 영역과 데이터를 자유롭게 주고받을 수 없다**. 그렇기 때문에 타겟 프로세스와 프로세스 타입을 [eBPF maps](https://docs.kernel.org/bpf/maps.html)에 저장해놓고 이벤트 발생시 해당 프로세스의 정보를 eBPF map에서 조회하여 사용한다.

> **[eBPF maps](https://docs.kernel.org/bpf/maps.html)란?**
>
> eBPF에서는 유저 영역과 데이터를 자유롭게 주고받을 수 없기에 둘 사이에 데이터를 공유하기 위한 저장소인 eBPF maps 기능을 제공한다. 유저 영역에서 데이터를 저장하여 eBPF 코드에서 조회할 수도 있고, eBPF 코드에서 데이터를 저장하여 유저 영역에서 조회할 수도 있다.
>
> 이름이 map인 것 처럼 key를 통해 조회(`BPF_MAP_LOOKUP_ELEM`), 삽입/수정(`BPF_MAP_UPDATE_ELEM`), 삭제(`BPF_MAP_DELETE_ELEM`)할 수 있다.
> <img style="height: 150px" src="https://github.com/rlaisqls/TIL/assets/81006587/5bf01023-6107-4441-a35b-b5fd2242ba7c"/>

어떤 프로세스에서 명령어가 실행되면 그 프로세스가 타겟인지 확인 후 필요한 정보를 구해 eBPF map에 저장해야한다. 이에 대한 구현을 다섯 과정으로 나누어 설명하면 아래와 같다.

1. **eBPF로 프로세스 실행 이벤트 받기** (Kernel space): <br> 프로세스에서 명령어가 실행되었다는 것은 `execveat`, `execve` 시스템 콜이 호출되었다는 뜻이다. `execveat`와 `execve` 시스템 콜의 커널 진입점인 `sys_execveat`, `sys_execve`가 호출되는 지점에  [kprobe](https://lwn.net/Articles/132196)를 삽입하여 eBPF 코드가 실행되도록 한다.

    ```go
    // kprobe를 삽입하는 코드
    // https://github.com/grafana/pyroscope/blob/774085f/ebpf/session.go#L753-L776
    hooks = []hook{
      ...
      {kprobe: "sys_execve", prog: s.bpf.Exec, ...},
      {kprobe: "sys_execveat", prog: s.bpf.Exec, ...},
    }
    for _, it := range hooks {
      kp, err := link.Kprobe(it.kprobe, it.prog, nil)
      ...
    }
    ```

2. **eBPF에서 perf로 결과 반환하기** (Kernel space): <br> kprobe로 호출된 eBPF 코드는 `bpf_perf_event_output()`으로 pid 정보를 반환한다. 이렇게 하면 `PERF_COUNT_SW_BPF_OUTPUT` 타입의 Linux perf event를 생성하여 fd로 이벤트를 받을 수 있다.

      > **perf event란?**<br>
      > Linux 성능 정보에 대한 event를 받을 수 있는 기능이다. [perf_event_open](https://man7.org/linux/man-pages/man2/perf_event_open.2.html) 시스템 콜을 사용해 event를 생성할 수 있고, event 발생시 fd(fild descripter)로 정보를 알 수 있다.<br>
      > perf event에는 여러 타입이 있는데, `PERF_COUNT_SW_BPF_OUTPUT`는 BPF 코드에서 반환이 발생했을 때 (BPF 코드에서 `bpf_perf_event_output()`를 실행했을 때) 그 정보를 알 수 있다.

    ```go
    // https://github.com/grafana/pyroscope/blob/774085f/ebpf/bpf/profile.bpf.c#L110-L124
    // execve/execveat
    SEC("kprobe/exec") 
    int BPF_KPROBE(exec, void *_) {
        u32 pid = 0;
        current_pid(global_config.ns_pid_ino, &pid);
        if (pid == 0) return 0;
        struct pid_event event = {
                .op  = OP_REQUEST_EXEC_PROCESS_INFO,
                .pid = pid
        };
        bpf_perf_event_output(ctx, &events, BPF_F_CURRENT_CPU, &event, sizeof(event));
        return 0;
    }
    ```

<!-- - 연관 커밋 ([profile only targets](https://github.com/grafana/pyroscope/commit/da9a377985e54ca1e888a4c3a5fd7044e590a5f8), [execve hook](https://github.com/grafana/pyroscope/commit/5163bcabcd9706bad0e474e2fce1b96e07792f0d#diff-48803d11d5ad31831fefb129df0cfbb7ed3b38cde6378a01f3103d74aba17dda)) -->
 
1. **eBPF에 대한 perf event 생성, 구독** (User space): <br> kprobe로 호출된 eBPF 코드의 output을 perf event로 받는 fd를 생성한다. 그리고 [epoll](https://man7.org/linux/man-pages/man2/poll.2.html) 시스템 콜을 통해 해당 fd를 구독한다. 

   epoll은 관찰 대상인 파일 디스크립터에 변경이 생겼을 때까지 기다렸다가 코드를 처리하도록 하는 시스템 콜이다. 여기에서도 perf 이벤트가 발생하면 해당 이벤트의 파일 디스크립터에 변경이 생기므로, 그 이벤트를 받아 처리하기 위해 사용한다.

    Pyroscope에선 Cilium에서 지원하는 eBPF 라이브러리의 [Reader](https://github.com/cilium/ebpf/blob/8079b37aa138b38707461cb8d548edf3359d6bc2/perf/reader.go#L137-L163) 구조체를 사용해 perf event 생성과 epoll System call 호출을 간접적으로 수행한다.

    ```go
    // https://github.com/cilium/ebpf/blob/8079b37/perf/ring.go#L102-L133
    // Reader에서 BPF output에 대한 perf event를 생성한다.
    ...
    attr := unix.PerfEventAttr{
      Type:        unix.PERF_TYPE_SOFTWARE,
      Config:      unix.PERF_COUNT_SW_BPF_OUTPUT,
      Bits:        uint64(bits),
      Sample_type: unix.PERF_SAMPLE_RAW,
      Wakeup:      uint32(wakeup),
    }

    attr.Size = uint32(unsafe.Sizeof(attr))
    fd, err := unix.PerfEventOpen(&attr, -1, cpu, -1, unix.PERF_FLAG_FD_CLOEXEC)
    ...
    ```
    
    ```go
    // https://github.com/cilium/ebpf/blob/8079b37/internal/epoll/poller.go#L110C3-L114C3
    // Reader 내부의 poller에서 poll 시스템 콜로 이벤트의 fd를 등록한다.
    ...
    if err := unix.EpollCtl(p.epollFd, unix.EPOLL_CTL_ADD, fd, &event); err != nil {
      return fmt.Errorf("add fd to epoll: %v", err)
    }
    ...
    ```

2. **프로세스에 대한 타겟 정보 구하기** (User space): <br> stack 해석을 위한 타입을 구분하기 위해, Perf event의 pid 정보를 가져와서 타겟 정보와 `/proc/{PID}/exe` 위치의 파일을 조회한다. `/proc/{PID}/exe` 위치에는 프로세스의 실행 명령어 경로가 있다. ([문서](https://man7.org/linux/man-pages/man5/procfs.5.html))

    위에서도 언급했듯 타입에는 `PYTHON`, `FRAMEPOINTER`가 있다. 접두어가 python이거나 [uwsgi](https://uwsgi-docs.readthedocs.io/en/latest/)이면 `PYTHON` 타입으로, 나머지 경우에는 `FRAMEPOINTER` 타입으로 해석한다.

    ```go
    // https://github.com/grafana/pyroscope/blob/774085f/ebpf/session.go#L675-L695
    func (s *session) selectProfilingType(pid uint32, target *sd.Target) procInfoLite {
      exePath, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
      ...
      exe := filepath.Base(exePath)
      if s.pythonEnabled(target) && strings.HasPrefix(exe, "python") || exe == "uwsgi" {
        return procInfoLite{pid: pid, typ: pyrobpf.ProfilingTypePython, ...}
      }
      return procInfoLite{pid: pid, typ: pyrobpf.ProfilingTypeFramepointers, ...}
    }
    ```

3. **eBPF map에 정보 저장하기** (User space): <br> 계산한 타입 정보를 `pid_config` map에 저장한다. 이제 프로세스 타입 정보를 map에서 조회하여 사용할 수 있다.

짧게 정리하자면, eBPF로 커널측의 프로세스 실행 이벤트를 받아서 User space에 [Perf](https://perf.wiki.kernel.org/index.php/Main_Page)로 이벤트를 넘긴다. 그리고 User space에서 poll을 사용하여 Perf 이벤트를 받고, Grafana Agent 서버에서 타겟 및 타입 정보를 구한 후 `pid_config`에 저장한다.

eBPF map인 `pid_config`에 타겟 프로세스와 프로세스 타입을 저장하는 과정을 도식으로 표현하면 아래와 같다.

<img style="width: 552px" alt="image" src="https://github.com/rlaisqls/blog/assets/81006587/835b8b83-8323-426c-a524-c2f845198303">

---

### 3. CPU에서 명령어 실행 시 스택 정보 수집

`pid_config`에 타겟 프로세스와 프로세스 정보를 저장해놓았으니, 이제 타겟에 대한 Profile 데이터를 수집하여 해석하는 부분을 살펴보자.

타겟에 대한 Profile 데이터는 `PERF_COUNT_SW_CPU_CLOCK` 타입의 Linux Perf 이벤트로 호출되는 eBPF를 사용해 수집한다. `PERF_COUNT_SW_CPU_CLOCK` 타입의 Perf는 어떤 CPU의 어떤 프로세스에서 어떤 명령어가 실행되었는지 정보를 전달한다.

이벤트 정보를 받았을 때 실행되는 eBPF 코드를 부분별로 코드와 함께 살펴보자.

프로세스 정보가 `pid_config` map에 존재하지 않으면:
  - Unknown 타입으로 저장해놓고, 타겟이 아닌 프로세스인지 한 번 확인하기 위해 `bpf_perf_event_output()`으로 pid 정보를 반환하여 2번 단계의 절차를 거치도록 한다.
  - User space에 있는 코드에서 비교했을 때 타겟에 해당하는 프로세스라면 unknown으로 저장했던 정보를 지우고 새 정보를 덮어씌운다.

    ```c
    // `pid_config` map에서 pid로 정보 조회
    struct pid_config *config = bpf_map_lookup_elem(&pids, &tgid); 
    if (config == NULL) { // 프로세스 정보가 `pid_config` map에 존재하지 않으면
      struct pid_config unknown = {
                  .type = PROFILING_TYPE_UNKNOWN,
                  .collect_kernel = 0,
                  .collect_user = 0,
                  .padding_ = 0
      };
      // 우선 Unknown 타입으로 저장해놓는다. update = 저장 및 수정
      if (bpf_map_update_elem(&pids, &tgid, &unknown, BPF_NOEXIST)) { 
        return 0;
      }
      /* 타겟이 아닌 프로세스인지 한 번 확인하기 위해
       * `bpf_perf_event_output()`으로 pid 정보를 반환하여
       * 2번 단계의 절차를 똑같이 거치도록 한다. */
      struct pid_event event = { 
        .op  = OP_REQUEST_UNKNOWN_PROCESS_INFO,
        .pid = tgid
      };
      bpf_perf_event_output(
        ctx, &events, BPF_F_CURRENT_CPU, &event, sizeof(event)
      );
      return 0;
    }
    ```

프로세스 정보가 `pid_config` map에 존재하면: 타입을 확인한다.
  - Unknown 타입이면: 무시하고 return한다.

    ```c
    if (config->type == PROFILING_TYPE_ERROR ||
        config->type == PROFILING_TYPE_UNKNOWN) {
      return 0;
    }
    ```

  - Python 타입이면: [`PyPerf`](https://github.com/grafana/pyroscope/pull/2201)로 Stack을 구한다.

    ```c
    // 여기서는 `bpf_tail_call`을 사용해 Pyperf에 대한 BPF 코드로 이동하도록 한다.
    if (config->type == PROFILING_TYPE_PYTHON) {
      bpf_tail_call(ctx, &progs, PROG_IDX_PYTHON);
      return 0;
    }
    ```

  - FramePointer 타입이면: `bpf_get_stackid`로 명령어의 [`Frame pointer`](http://en.wikipedia.org/wiki/Frame_pointer#Structure) Stack을 구한다. Stack을 구한 후에는 그 결과를 `count`라는 eBPF map에 저장하여 스택 호출 횟수를 센다.

    ```c
    if (config->type == PROFILING_TYPE_FRAMEPOINTERS) {
      key.pid = tgid;
      ...
      // `bpf_get_stackid`로 명령어의 Frame pointer stack을 구한다.
      key.user_stack = -1;
      if (config->collect_user) {
        key.user_stack = bpf_get_stackid(ctx, &stacks, USER_STACKID_FLAGS);
      }

      // stack 결과를 `count`라는 eBPF map에 저장하여 명령어 호출 횟수를 센다.
      val = bpf_map_lookup_elem(&counts, &key);
      if (val) // 같은 스택의 명령어가 있었다면 값을 증가시키고
        (*val)++;
      else // 같은 스택의 명령어가 없었다면 1 값으로 삽입한다.
        bpf_map_update_elem(&counts, &key, &one, BPF_NOEXIST);
    }
    ```

<details>
<summary>전체 코드</summary>
<div markdown="1">

  ```c
  // https://github.com/grafana/pyroscope/blob/774085f91bb9262c2f3cd46797a7e4313da295dd/ebpf/bpf/profile.bpf.c#L19
  SEC("perf_event")
  int do_perf_event(struct bpf_perf_event_data *ctx) {
      ...
      // `pid_config` map에서 pid로 정보 조회
      struct pid_config *config = bpf_map_lookup_elem(&pids, &tgid); 
      if (config == NULL) { // 프로세스 정보가 `pid_config` map에 존재하지 않으면
          struct pid_config unknown = {
                  .type = PROFILING_TYPE_UNKNOWN,
                  .collect_kernel = 0,
                  .collect_user = 0,
                  .padding_ = 0
          };
          // 우선 Unknown 타입으로 저장해놓는다. update = 저장 및 수정
          if (bpf_map_update_elem(&pids, &tgid, &unknown, BPF_NOEXIST)) { 
              bpf_dbg_printk("failed to update pids map. probably concurrent update\n");
              return 0;
          }
          // 타겟이 아닌 프로세스인지 한 번 확인하기 위해 `bpf_perf_event_output()`으로 pid 정보를 반환하여
          // 2번 단계의 절차를 똑같이 거치도록 한다.
          struct pid_event event = {
                  .op  = OP_REQUEST_UNKNOWN_PROCESS_INFO,
                  .pid = tgid
          };
          bpf_perf_event_output(ctx, &events, BPF_F_CURRENT_CPU, &event, sizeof(event));
          return 0;
      }

      // Unknown 타입이면 무시하고 return한다.
      if (config->type == PROFILING_TYPE_ERROR || config->type == PROFILING_TYPE_UNKNOWN) {
          return 0;
      }

      // Python 타입이면 `PyPerf`로 stack을 구한다. 여기서는 bpf_tail_call을 사용해 Pyperf에 대한 BPF 코드로 이동하도록 한다.
      if (config->type == PROFILING_TYPE_PYTHON) {
          bpf_tail_call(ctx, &progs, PROG_IDX_PYTHON);
          return 0;
      }

      // FramePointer 타입이면
      if (config->type == PROFILING_TYPE_FRAMEPOINTERS) {
          key.pid = tgid;
          ...
          // `bpf_get_stackid`로 명령어의 Frame pointer stack을 구한다.
          key.user_stack = -1;
          if (config->collect_user) {
              key.user_stack = bpf_get_stackid(ctx, &stacks, USER_STACKID_FLAGS);
          }

          // stack 결과를 `count`라는 eBPF map에 저장하여 명령어 호출 횟수를 센다.
          val = bpf_map_lookup_elem(&counts, &key);
          if (val) // 같은 스택의 명령어가 있었다면 값을 증가시키고
              (*val)++;
          else // 같은 스택의 명령어가 없었다면 1 값으로 삽입한다.
              bpf_map_update_elem(&counts, &key, &one, BPF_NOEXIST);
      }
      return 0;
  }
  ```

</div>
</details>

CPU에서 실행된 명령어 Stack 정보를 저장하는 흐름에 대한 도식은 다음과 같다. (아래 도식에서 2번과 4번으로 표시된 항목은 위 코드의 `do_perf_event` 함수 하나에 있는 코드이지만 흐름을 나타내기 위해 분리했다.)

<img style="width: 552px" alt="image" src="https://github.com/rlaisqls/blog/assets/81006587/be279573-e456-4770-952c-29607791bb4c">

### 4. Stack 정보 해석 및 심볼 변환

Grafana Agent는 `count` map에 있는 정보를 주기적으로 조회하고(기본 15초), Profile 정보 형태로 변환하여 Pyroscope 서버로 전송한다. Profile 정보로 변환하기 위해 가장 중요한 과정은 포인터로 되어있는 stack을 사람이 읽을 수 있는 함수명(Symbol)으로 바꾸는 것이다.

기본적으로 사용되는 `FlamePointer` 타입의 구현을 살펴보자. 

#### 4-1. WalkStack 함수

Grafana Agent는 `count`를 조회하여 stack 정보를 가져온다. `FlamePointer` 타입의 Stack 정보는 8비트의 명령어 주소가 여러개 붙어있는 형태의 byte 배열이다. 

`WalkStack` 함수에는 stack 정보를 파라미터로 넘겨받아서 각 명령어별 Symbol을 string으로 해석해서 string 배열로 변환한다. 명령어별 이름은 `resolver.Resolve()`에서 해석된다.

```go
// https://github.com/grafana/pyroscope/blob/774085f/ebpf/session.go#L531-L571
// WalkStack goes over stack, resolves symbols and appends top sb
// stack is an array of 127 uint64s, where each uint64 is an instruction pointer
func (s *session) WalkStack(sb *stackBuilder, stack []byte, resolver symtab.SymbolTable, stats *StackResolveStats) {
  ...
  begin := len(sb.stack)
  for i := 0; i < 127; i++ {
    instructionPointerBytes := stack[i*8 : i*8+8]
    instructionPointer := binary.LittleEndian.Uint64(instructionPointerBytes)
    ...
    sym := resolver.Resolve(instructionPointer)
    var name string
    if sym.Name != "" {
      name = sym.Name
      stats.known++
    }
    ...
    sb.append(name)
  }
  end := len(sb.stack)
  lo.Reverse(sb.stack[begin:end])
}
```

#### 4-2. 명령어가 매핑된 파일 구하기

위 함수에서 resolver(SymbolTable)은 ELF 섹션 정보를 사용해 명령어의 Symbol을 구한다. 

> **ELF란?**<br>
> ELF는 Executable and Linking Format의 약어로, UNIX / LINUX 기반에서 사용되는 실행 및 링킹 파일 포맷이다. 파일의 ELF 섹션에는 Linking을 위한 명령어 주소, 데이터, 심볼 테이블, 재배치 정보 등이 담겨있다. 이 정보를 통해 명령어 주소에 대한 Symbol을 구할 수 있다.<br>

> **참고**<br>
> 여기서 한 가지 신경써야하는 부분은, JIT 방식으로 컴파일하는 애플리케이션(node.js, java)은 ELF 테이블에서 함수 Symbol을 조회할 수 없다는 점이다. JIT 에서는 ELF 테이블에 JIT 함수의 이름만이 남는다. <br>
> 컴파일한 함수의 위치를 디스크 별도 위치(`/tmp/perf-{PID}.map`)에 갱신하면서 저장하는 방식으로 함수 Symbol을 구할 수 있지만, Pyroscope에서는 해당 기능을 아직 제공하지 않는다. ([기능 지원에 대한 이슈](https://github.com/grafana/pyroscope/issues/2766))<br>
> 관련된 정보는 [여기](https://www.brendangregg.com/perf.html#JIT_Symbols)서 참고할 수 있다. 이 방식은 Rust, C/C++에서 정확한 함수명을 구할 수 있다.

어떤 파일의 ELF 정보를 확인해야하는지는 `/proc/{PID}/maps` 위치의 파일로 확인할 수 있다. `/proc/{PID}/maps` 위치의 파일은 프로세스가 사용하는 메모리가 어느 주소에 매핑되어있는지를 저장하고 있다. ([문서](https://man7.org/linux/man-pages/man5/procfs.5.html))

- `/proc/{PID}/maps` 파일 예시

    ```
    address                   perms offset   dev   inode   pathname
    7faa726a0000-7faa726a3000 rw-p  001ea000 08:30 11971   /usr/lib/x86_64-linux-gnu/libc-2.31.so
    7faa726a3000-7faa726a9000 rw-p  00000000 00:00 0
    7faa726a9000-7faa726aa000 r--p  00000000 08:30 3032    /usr/lib/locale/C.UTF-8/LC_TELEPHONE
    7faa726aa000-7faa726ab000 r--p  00000000 08:30 3025    /usr/lib/locale/C.UTF-8/LC_MEASUREMENT
    7faa726ab000-7faa726b2000 r--s  00000000 08:30 11818   /usr/lib/x86_64-linux-gnu/gconv/gconv-modules.cache
    7faa726b2000-7faa726b3000 r--p  00000000 08:30 11854   /usr/lib/x86_64-linux-gnu/ld-2.31.so
    ```

특정 파일 정보를 메모리에 매핑했다면, 즉 특정 프로세스에서 컴파일된 파일을 메모리에 올려 사용하고 있다면 `pathname` 속성에 해당 파일의 경로 정보가 남는다. 찾고자 하는 명령어가 어떤 파일에 매핑되어있는지 확인한 후, 해당 경로의 ELF 섹션을 확인하면 함수 이름을 알 수 있다.

이를 위해, 우선 타겟 프로세스에 대한 `/proc/{PID}/maps` 파일을 읽어 명령어가 어떤 파일에 매핑되어있는지를 확인한다. 그리고 파일 정보의 각 줄을 [해석](https://github.com/grafana/pyroscope/blob/774085f91bb9262c2f3cd46797a7e4313da295dd/ebpf/symtab/procmap.go#L284)하여 [`ProcMap`](https://github.com/grafana/pyroscope/blob/774085f91bb9262c2f3cd46797a7e4313da295dd/ebpf/symtab/procmap.go#L58-L73)이라는 구조체에 정보를 담아놓는다. 해석한 정보를 담은 구조체를 [`elfRange`](https://github.com/grafana/pyroscope/blob/774085f91bb9262c2f3cd46797a7e4313da295dd/ebpf/symtab/proc.go#L63) 타입으로 감싸서 [`ProcTable`](https://github.com/grafana/pyroscope/blob/774085f91bb9262c2f3cd46797a7e4313da295dd/ebpf/symtab/proc.go#L18-L25) 구조체에 배열로 저장한다.

```go
type elfRange struct {
  mapRange *ProcMap
  elfTable *ElfTable
}

type ProcTable struct {
  logger     log.Logger
  ranges     []elfRange
  file2Table map[file]*ElfTable
  options    ProcTableOptions
  rootFS     string
  err        error
}
```

이제 `ranges` 배열에서 이분탐색을 수행하면, 찾고자 하는 명령어가 매핑된 파일을 찾을 수 있다.

  ```go
  // https://github.com/grafana/pyroscope/blob/774085f/ebpf/symtab/proc.go#L141-L161
  func (p *ProcTable) Resolve(pc uint64) Symbol {
    if pc == 0xcccccccccccccccc || pc == 0x9090909090909090 {
      return Symbol{Start: 0, Name: "end_of_stack", Module: "[unknown]"}
    }
    i, found := slices.BinarySearchFunc(p.ranges, pc, binarySearchElfRange)
    ...
    r := p.ranges[i]
    t := r.elfTable
    ...
    s := t.Resolve(pc)
    moduleOffset := pc - t.base
    if s == "" {
      return Symbol{Start: moduleOffset, Module: r.mapRange.Pathname}
    }
    return Symbol{Start: moduleOffset, Name: s, Module: r.mapRange.Pathname}
  }
  ```


#### 4-3. elf table 정보 읽기

명령어가 어떤 파일에 매핑되어있는지 알았으니 해당 파일의 ELF 섹션을 해석하여 실제 데이터의 함수명(symbol)을 구해야 한다. 이 과정은 [`NewSymbolTable()`](https://github.com/grafana/pyroscope/blob/774085f91bb9262c2f3cd46797a7e4313da295dd/ebpf/symtab/elf/symbol_table.go#L91) 함수에서 이뤄진다. 

Symbol 정보를 알기 위해서는 `SHT_SYMTAB`, `SHT_DYNSYM` 두 섹션의 정보가 필요하므로 두 섹션의 정보를 각각 해석하여 [SymbolTable](https://github.com/grafana/pyroscope/blob/774085f91bb9262c2f3cd46797a7e4313da295dd/ebpf/symtab/elf/symbol_table.go#L44) 구조체에 담는다.

```go
// https://github.com/grafana/pyroscope/blob/774085f91bb9262c2f3cd46797a7e4313da295dd/ebpf/symtab/elf/symbol_table.go#L91-L132
func (f *MMapedElfFile) NewSymbolTable(opt *SymbolsOptions) (*SymbolTable, error) {

  // SHT_SYMTAB, SHT_DYNSYM 섹션에 해당하는 Symbol을 가져온다.
	sym, sectionSym, err := f.getSymbols(elf.SHT_SYMTAB, opt)
	dynsym, sectionDynSym, err := f.getSymbols(elf.SHT_DYNSYM, opt)
	total := len(dynsym) + len(sym)
	...
	all := make([]SymbolIndex, 0, total)
	all = append(all, sym...)
	all = append(all, dynsym...)
  // 주소를 기준으로 정렬한다.
	sort.Slice(...)

  // Index에 이름과 주소(value)를 배열로 저장한다.
	res := &SymbolTable{
    Index: FlatSymbolIndex{
      Links: []elf.SectionHeader{
        f.Sections[sectionSym],    // should be at 0 - SectionTypeSym
        f.Sections[sectionDynSym], // should be at 1 - SectionTypeDynSym
      },
      Names:  make([]Name, total),
      Values: gosym.NewPCIndex(total),
    },
		File:            f,
		demangleOptions: opt.DemangleOptions,
	}
	for i := range all {
		res.Index.Names[i] = all[i].Name
		res.Index.Values.Set(i, all[i].Value)
	}
	return res, nil
}
```

#### 4-4. elf table 정보에서 함수 이름 탐색

각 경로에 대한 파일의 ELF 섹션을 해석해서 [`SymbolTable`](https://github.com/grafana/pyroscope/blob/774085f91bb9262c2f3cd46797a7e4313da295dd/ebpf/symtab/elf/symbol_table.go#L44) 구조체에 저장하면, `SymbolTable` 구조체의 `Resolve` 함수는 `Index.Values`주소를 통해 해당 주소에 대한 함수명을 구할 수 있게 된다. 원하는 symbol이 있는 index를 구할 때도 이분 탐색을 활용한다.

```go
// https://github.com/grafana/pyroscope/blob/774085f/ebpf/symtab/elf/symbol_table.go#L44
type SymbolTable struct {
	Index FlatSymbolIndex
	File  *MMapedElfFile
  ...
}

func (st *SymbolTable) Resolve(addr uint64) string {
  // 이분탐색으로 배열에서의 index를 구한다.
	i := st.Index.Values.FindIndex(addr) 
	...
	name, _ := st.symbolName(i)
	return name
}
...
func (st *SymbolTable) symbolName(idx int) (string, error) {
	linkIndex := st.Index.Names[idx].LinkIndex()
	SectionHeaderLink := &st.Index.Links[linkIndex]
	NameIndex := st.Index.Names[idx].NameIndex()

  // 구한 idx에 있는 symbol 주소에 offset을 더해 이름을 가져온다.
	s, b := st.File.getString(int(NameIndex)+int(SectionHeaderLink.Offset), st.demangleOptions)
	if !b {
		return "", fmt.Errorf("elf getString")
	}
  // 이름을 string으로 반환한다.
	return s, nil
}
```

### 5. pprof 형식으로 데이터 변환 및 전송
 
Symbol을 모두 구하면 stack trace를 나타내는 string 배열이 결과로 나온다. 이제 이 결과를 Pyroscope 서버로 전송하기 위한 포맷으로 변환해야한다. Pyroscope에서는 [pprof](https://github.com/google/pprof/tree/main) 형식으로 데이터를 주고 받는다. google의 [pprof/profile](https://github.com/google/pprof/tree/main) 라이브러리를 사용해 형식을 변환한다.

[반환 데이터 구조](https://github.com/google/pprof/blob/main/proto/profile.proto)를 간단하게 설명하자면 다음과 같다.

- **Profile**: 가장 상위 메시지로, 전체 프로파일을 나타낸다. 프로파일에는 Sample, Location, Function 등이 포한된다.
- **Sample**: 프로파일링 정보로 수집된 개별 샘플을 나타낸다. Sample은 호출 스택에 대한 각 Location의 배열과 그 위치에서의 profile 정보(e.g. CPU 사용량)를 포함한다. 
- **Location**: 각 위치는 특정 함수 호출 또는 명령어 주소를 나타낸다. 각 Location은 하나 이상의 Function과 연결된다.
- **Function**: 함수 정보를 나타낸다. 소스 파일 이름, 시작 라인 등을 포함한다. 

pprof 형식의 가장 큰 특징은 string 정보를 `string_table`에 별도로 가지고 있다는 점이다. 모든 string은 `string_table`에 담고, 정보를 포함한 sample과 function에는 `string_table`에 있는 해당 string의 index 값을 넣는다. 이를 통해 다량의 데이터를 적은 용량으로 전송할 수 있도록 한다.

stack 정보에 해당하는 함수명 Symbol 목록을 구한 후 변환하여 Pyroscope 서버로 보내는 전체 과정을 도식화 하면 아래와 같다.

<img style="width: 552px" alt="image" src="https://github.com/rlaisqls/blog/assets/81006587/d5005648-007a-4d38-8393-f51e690c62c9">

---

## 정리 및 마무리

전체 과정을 정리하면 다음과 같다.

1. **타겟 프로세스 등록**<br>
  프로파일링할 대상 프로세스를 PID 기준으로 타겟으로 등록한다.
2. **프로세스 실행 이벤트 감지 및 타입 결정**<br>
  `execve`, `execveat` 시스템 콜의 kprobe에 eBPF 코드를 삽입하여 프로세스 실행 이벤트를 감지한다. 프로세스 경로를 조회하여 Python 또는 FramePointer 타입을 결정하고, 이 정보를 eBPF map에 저장한다.
3. **CPU에서 명령어 실행 시 스택 정보 수집**<br>
  `PERF_COUNT_SW_CPU_CLOCK` 이벤트로 eBPF 코드가 실행되면, 타겟 프로세스 여부와 타입에 따라 적절한 eBPF 코드를 실행한다. FramePointer 타입일 경우 bpf_get_stackid로 스택 정보를 수집하고 count map에 저장한다.
4. **스택 정보 해석 및 심볼 변환**<br>
  `/proc/{PID}/maps`를 조회하여 명령어가 매핑된 파일 경로를 확인한다. 해당 파일의 ELF 섹션에서 명령어 주소에 대한 심볼(함수명)을 획득하고, 스택 정보의 명령어 주소를 해당 심볼로 변환한다.
5. **pprof 형식으로 데이터 변환 및 전송**<br>
  심볼로 변환된 스택 정보를 pprof 형식으로 변환하고, 프로파일 샘플, 위치, 함수 정보 등을 포함하는 pprof 메시지를 생성한다. 생성된 pprof 메시지를 Pyroscope 서버로 전송한다.

<img style="width: 652px" alt="image" src="https://github.com/rlaisqls/blog/assets/81006587/7c18ce37-7d7d-421c-bcbe-e43c557b14a2">


Pyroscope의 eBPF를 사용한 프로파일링 정보 수집 과정을 상세히 살펴봄으로써, eBPF의 작동 방식과 프로파일링 데이터 수집 및 해석 과정에 대해 더 자세히 이해할 수 있었다. eBPF를 사용한 프로파일링은 낮은 오버헤드와 세부 수준의 정보 수집이 가능하다는 장점이 있다. 하지만 지원되는 언어가 제한적이고, 메모리 및 스레드 프로파일링을 지원하지 않는 단점도 있다. 

공부 전에는 eBPF가 만능일거라는 착각(?)을 했었는데 생각보다는 쓸 수 있는 범위가 좁다는 걸 느꼈다. 다른 기술은 다른 기술대로 장점이 있고, eBPF는 eBPF만의 특화된 영역이 있는 것 같다. 앞으로도 eBPF를 사용해 구현하는 성능 모니터링 툴과 도구, 그리고 그 외의 다양한 활용 가능성에 대해 계속해서 관심을 가지고 살펴봐야겠다.

---

<details>
<summary>참고 링크</summary>
<div markdown="1">

**참고한 블로그**
- https://www.brendangregg.com/flamegraphs.html
- https://www.emaallstars.com/categories-of-ebpf-tools.html
- https://fedepaol.github.io/blog/2023/09/24/ebpf-journey-by-examples-perf-events-with-pyroscope
- https://ebpf-docs.dylanreimerink.nl/linux/program-type/BPF_PROG_TYPE_PERF_EVENT/
- https://www.brendangregg.com/perf.html
- https://terenceli.github.io/%E6%8A%80%E6%9C%AF/2020/08/29/perf-arch

**참고한 공식 문서**
- Pyroscope, Grafana Agent(alloy)
  - https://grafana.com/docs/pyroscope/latest/
  - https://grafana.com/docs/agent/latest/
  - https://grafana.com/docs/pyroscope/latest/configure-client/grafana-agent/ebpf/
  - https://grafana.com/docs/pyroscope/latest/configure-client/grafana-agent/ebpf/configuration/
  - https://grafana.com/docs/alloy/latest/reference/components/pyroscope.ebpf/
- libbpf
  - https://docs.kernel.org/bpf/libbpf/program_types.html
  - https://github.com/libbpf/libbpf/blob/02724cf/src/bpf.h#L26
- bcc
  - https://github.com/iovisor/bcc/blob/80fcfc9/docs/reference_guide.md
- man
  - https://man7.org/linux/man-pages/man5/procfs.5.html
  - https://man7.org/linux/man-pages/man1/perf.1.html
  - https://man7.org/linux/man-pages/man2/perf_event_open.2.html
  - https://man7.org/linux/man-pages/man7/epoll.7.html

</div>
</details>

<details>
<summary>관련 TIL</summary>
<div markdown="1">

- eBPF
  - eBPF 개념: [BPF](../../../til/os/linux/bpf/bpf/), [BPF 프로그램 타입](../../../til/os/linux/bpf/bpf%ED%94%84%EB%A1%9C%EA%B7%B8%EB%9E%A8%ED%83%80%EC%9E%85/)
  - eBPF 활용 함수, 라이브러리: [BPF System Call](../../../til/os/linux/bpf/bpfsystemcall/), [libbpf helper 함수](../../../til/os/linux/bpf/libbpfhelper%ED%95%A8%EC%88%98/), [BCC](../../../til/os/linux/bpf/bcc/)
- System Call
  - ELF: [ELF](../../../til/os/linux/elf/elf/), [SEC()](../../../til/os/linux/elf/sec/)
  - FramePointer: [Stack trace와 kallsyms](../../../til/os/linux/stacktrace%EC%99%80kallsyms/)
  - perf: [Perf](../../..//til/os/linux/etc/perf/), [perf event](../../../til/os/linux/systemcall/perfevent/)
  - epoll: [epoll](../../..//til/os/linux/systemcall/epoll/)
  - kprobe: [kprobe와 kretprobe](../../../til/os/linux/krobe%EC%99%80kretprobe/)
  - exec, execat: [fork와 exec](../../../til/os/linux/systemcall/fork%EC%99%80exec/)

</div>
</details>