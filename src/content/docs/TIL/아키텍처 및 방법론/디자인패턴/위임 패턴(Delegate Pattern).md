---
title: '위임 패턴(Delegate Pattern)'
lastUpdated: 2024-05-22T08:39:15
---

소프트웨어 엔지니어링에서 delegate pattern(위임 패턴)은 객체 합성이 상속과 동일하게 코드 재사용을 할 수 있도록 하는 객체 지향 디자인 패턴이다.

## 상속(inheritance) vs 합성(composition)
객체지향 시스템에서 기능의 재사용을 위해 구사하는 가장 대표적인 기법은 클래스 상속, 그리고 객체 합성(object composition)이다.

## 클래스 상속

- 서브클래싱, 즉 다른 부모 클래스에서 상속받아 한 클래스의 구현을 정의하는 것.
- 서브클래싱에 의한 재사용을 화이트박스 재사용(white-box reuse)이라고 한다.
- '화이트박스’는 내부를 볼 수 있다는 의미에서 나온 말로, 상속을 받으면 부모 클래스의 내부가 서브클래스에 공개되기 때문에 화이트박스인 셈이다.

### 상속의 장점

- 컴파일 시점에 정적으로 정의되고 프로그래밍 언어가 직접 지원하므로 그대로 사용하면 된다.
- 서브클래스는 부모클래스의 일부만 재정의할 수도 있다.

### 상속의 단점

- 런타임에 상속받은 부모 클래스의 구현을 변경할 수 없다.
- 상속은 컴파일 시점에 결정되는 사항이기 때문.
- 부모 클래스는 서브클래스의 물리적 표현의 최소 부분만을 정의하기 때문에 서브클래스는 부모 클래스가 정의한 물리적 표현들을 전부 또는 일부 상속받는다.
- 상속은 부모 클래스의 구현이 서브클래스에 다 드러나는 것이기 때문에 상속은 캡슐화를 파괴한다고 보는 시각도 있다.
- 서브클래스는 부모 클래스의 구현에 종속될 수밖에 없으므로, 부모 클래스 구현에 변경이 생기면 서브클래스도 변경해야 한다.

이 구현의 종속성이 걸림돌로 작용하면서, 서브클래스를 재사용하려고 할 때 문제가 발생한다. 상속한 구현이 새로운 문제에 맞지 않을 때, 부모 클래스를 재작성해야 하거나 다른 것으로 대체하는 일이 생기게 된다. 이런 종속성은 유연성과 재사용성을 떨어뜨린다.

이를 해결하는 방법 한 가지는 추상 클래스에서만 상속 받는 것이다. 추상 클래스에는 구현이 거의 없거나 아예 없기 때문이다. 이미 추상 클래스를 상속했다는 것은 구현이 아닌 인터페이스를 상속한 것이므로 구현 자체는 서브클래스가 정의한다. 구현이 변경되면 서브클래스만 변경하면 되고 상위 추상 클래스는 고려할 필요가 없다.

## 객체 합성
- 클래스 상속에 대한 대안으로 다른 객체를 여러 개 붙여서 새로운 기능 혹은 객체를 구성하는 것이다.
- 즉, 객체 또는 데이터 유형을 더 복잡한 유형으로 결합하는 방법
- 객체를 합성하려면, 합성에 들어가는 객체들의 인터페이스를 명확하게 정의해 두어야 한다.
- 이런 스타일의 재사용을 블랙박스 재사용(black-box reuse)이라고 한다.
- 객체의 내부는 공개되지 않고 인터페이스를 통해서만 재사용되기 때문.

객체 합성은 한 객체가 다른 객체에 대한 `참조자`를 얻는 방식으로 런타임에 동적으로 정의된다. 합성은 객체가 다른 객체의 인터페이스만을 바라보게 하기 때문에, 인터페이스 정의에 더 많은 주의를 기울여야 한다. 객체는 **인터페이스에서만 접근하므로 캡슐화**를 유지할 수 있다. 동일한 타입을 갖는다면 다른 객체로 런타임에 대체가 가능하다. 객체는 인터페이스에 맞춰 구현되므로 구현 사이의 종속성이 확실히 줄어든다.

객체 합성은 시스템 설계에 또 다른 영향을 끼친다. 클래스 상속보다 객체 합성을 더 선호하는 이유는 각 클래스의 **캡슐화를 유지**할 수 있고, **각 클래스의 한 가지 작업에 집중**할 수 있기 때문이다. 객체 합성으로 설계되면 클래스의 수는 적어지고 객체의 수는 좀더 많아질 수 있지만, 시스템의 행동은 클래스에 정의된 정적인 내용보다는 런타임에 드러나는 객체 합성에 의한 상호 관련성에 따라 달라질 수 있다.

결론적으로 객체 합성을 사용하면 **재사용을 위해서 새로운 구성요소를 생성할 필요 없이 필요한 기존의 구성요소를 조립해서 모든 새로운 기능을 얻어올 수 있다.** 하지만 기존 구성요소의 조합을 통한 재사용만으로 목적을 달성할 수 있는 경우는 드물다. 상속에 의한 재사용은 기존 클래스들을 조합해서 새로운 구성요소를 쉽게 만들 수 있도록 해 준다. 그러므로 상속과 객체 합성은 적절히 조합되어야만 완벽히 재사용이 가능하다.

## 위임(delegation)

위임은 합성을 상속만큼 강력하게 만드는 방법이다.

위임에서는 두 객체가 하나의 요청을 처리한다. 수신 객체가 연산의 처리를 위임자(delegate)에게 보낸다. 이는 서브클래스가 부모 클래스에게 요청을 전달하는 것과 유사한 방식이다.

위임과 동일한 효과를 얻으려면 수신 객체는 대리자에게 자신을 매개변수로 전달해서 위임된 연산이 수신자를 참조하게 한다.

```java
class Rectangle(val width: Int, val height: Int) {
    fun area() = width * height
}

class Window(val bounds: Rectangle) {
    // Delegation
    fun area() = bounds.area()
}
```

`Window` 클래스는 `Rectangle` 클래스를 자신의 인스턴스 변수로 만들고 `Rectangle` 클래스에 정의된 행동이 필요할 때는 Rectangle 클래스에 위임함으로써 `Rectangle`의 행동을 재사용할 수 있다.

다시 말해, 상속처럼 Window 인스턴스를 Rectangle 인스턴스로 간주하는 방식이 아닌 Window 인스턴스가 Rectangle 인스턴스를 포함하도록 하고, Window 인스턴스는 자신이 받은 요청을 Rectangle 인스턴스로 전달하는 것이다.


`Window` 클래스는 `area()` 연산을 `Rectangle` 인스턴스에 전달한다.

실선 화살표는 한 클래스가 다른 클래스의 인스턴스에 대한 참조자를 갖고 있음을 보여준다. 참조는 이름을 선택적으로 정의할 수 있는데, 다이어그램에선 rectangle로 정의한다.

위임의 가장 중요한 장점은 런타임에 행동의 조합을 가능하게 하고, 조합하는 방식도 변경해준다는 것이다.

`Window` 객체가 런타임에 `Rectangle` 인스턴스를 `Circle` 인스턴스로 대체하면 원형의 윈도우가 될 것이다. (물론 이를 위해서는 Rectangle 클래스와 Circle 클래스가 동일한 타입이라는 가정이 필요하다.)

위임이 갖는 단점은 객체 합성을 통해 소프트웨어 설계의 유연성을 보장하는 방법과 동일하게 동적인데다가 고도로 매개변수화된 소프트웨어는 정적인 소프트웨어 구조보다 이해하기가 더 어렵다. 왜냐하면 클래스의 상호작용이 다 정의되어 있는 것이 아니고, 런타임 객체에 따라서 항상 그 결과가 달라지기 때문이다. 위임은 그러한 복잡함보다 단순화의 효과를 더 크게 할 수 있는 경우에 사용하면 좋다. 

### 위임을 부분적으로 사용하는 디자인 패턴

- 상태(State) 패턴
- 전략(Strategy) 패턴
- 방문자(Visitor) 패턴
  
상태 패턴에서 객체는 현재 상태를 표현하는 상태 객체에 요청의 처리를 위임한다. 전략 패턴에서 객체는 요청을 수행하는 추상화한 전략 객체에게 특정 요청을 위임한다.

이 두 패턴의 목적은 처리를 전달하는 객체를 변경하지 않고 객체의 행동을 변경할 수 있게 하자는 것이다.
방문자 패턴에서, 객체 구조의 각 요소에 수행하는 연산은 언제나 방문자 객체에게 위임된 연산이다.

### 위임에 전적으로 의존하는 디자인 패턴

- 중재자(Mediator) 패턴
- 책임 연쇄(Chain of Responsibility) 패턴
- 가교(Bridge) 패턴

중재자 패턴은 객체 간의 교류를 중재하는 객체를 도입하여 중재자 객체가 다른 객체로 연산을 전달하도록 구현한다. 이때, 연산에 자신에 대한 참조자를 함께 보내고 위임받은 객체가 다시 자신에게 메시지를 보내서 자신이 정의한 데이터를 얻어가게 함으로써 진정한 위임을 구현한다.

책임 연쇄 패턴은 한 객체에서 다른 객체로 고리를 따라서 요청의 처리를 계속 위임한다. 이 요청에는 요청을 처음 받은 원본 객체에 대한 참조자를 포함한다.

위임은 객체 합성의 극단적인 예로서, 코드 재사용을 위한 매커니즘으로 상속을 객체 합성으로 대체할 수 있다.

## 코틀린의 위임

코틀린은 기본적으로 보일러 플레이트가 필요 없이 위임 패턴을 지원한다.

`Window`의 supertype 목록에 있는 `by` 절은 `bounds`가 `Window`의 객체 내부에 저장되고, `컴파일러가 bounds`로 전달하는 `ClosedShape`의 모든 메서드를 생성함을 의미한다.

```kotlin
interface ClosedShape {
    fun area(): Int
}

class Rectangle(val width: Int, val height: Int) : ClosedShape {
    override fun area() = width * height
}

class Window(private val bounds: ClosedShape) : ClosedShape by bounds
```