---
title: "Kotest Assertions"
lastUpdated: 2026-01-16T15:16:04
---

https://kotest.io/docs/assertions/assertions.html

**Assertions**

- shouldBe

```kotlin
name shouldBe "eunbin"
// == assertThat(name).isEqualTo("eunbin")
```

**Inspectors**

- forExactly

```kotlin
mylist.forExactly(3) {
    it.city shouldBe "Chicago"
}
```

- forAtLeast

```kotlin
val xs = listOf("sam", "gareth", "timothy", "muhammad")

xs.forAtLeast(2) {
    it.shouldHaveMinLength(7)
}
```

**Exceptions**

- shouldThrow

```kotlin
shouldThrow {
  // code in here that you expect to throw an IllegalAccessException
}
// == assertThrows { }
```

- shouldThrowAny
  
```kotlin
val exception = shouldThrowAny {
  // test here can throw any type of Throwable!
}
```
