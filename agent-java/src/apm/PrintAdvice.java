package apm;

import net.bytebuddy.asm.Advice;

// JDK Throwable.printStackTrace() 앞. 로거를 거치지 않는 예외 출력도 예외로 남긴다.
public final class PrintAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static void enter(@Advice.This Throwable t) {
    Tracer.printed(t.getClass().getName(), t.getMessage());
  }
}
