package apm;

import net.bytebuddy.asm.Advice;

// Statement/PreparedStatement의 execute* 앞뒤. 깊이 카운터 때문에 sqlStart를 불렀으면 sqlEnd도 반드시 불린다.
public final class SqlAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Span enter(@Advice.This Object stmt, @Advice.AllArguments Object[] args) {
    return Tracer.sqlStart(stmt, args);
  }

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Span span, @Advice.Thrown Throwable thrown) {
    Tracer.sqlEnd(span, thrown);
  }
}
