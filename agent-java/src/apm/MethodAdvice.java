package apm;

import net.bytebuddy.asm.Advice;

// 앱 Controller·Service 클래스의 public 메서드 앞뒤. 메서드 흐름(들여쓰기)을 만든다.
public final class MethodAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Span enter(@Advice.Origin("#t") String type, @Advice.Origin("#m") String method) {
    return Tracer.methodStart(type, method);
  }

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Span span, @Advice.Thrown Throwable thrown) {
    Tracer.methodEnd(span, thrown);
  }
}
