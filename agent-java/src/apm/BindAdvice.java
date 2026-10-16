package apm;

import net.bytebuddy.asm.Advice;

// PreparedStatement의 setXxx(번호, 값)와 clearParameters()의 뒤. 넣은 값을 문장 객체별로 기억한다.
// Hikari·log4jdbc 겹마다 불리지만, 실행 때는 가장 바깥 객체의 값만 쓴다.
public final class BindAdvice {
  @Advice.OnMethodExit(suppress = Throwable.class)
  static void exit(@Advice.This Object stmt, @Advice.Origin("#m") String method,
      @Advice.AllArguments Object[] args) {
    Tracer.bind(stmt, method, args);
  }
}
