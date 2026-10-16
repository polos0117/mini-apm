package apm;

import net.bytebuddy.asm.Advice;

// Connection.prepareStatement(String, ...)/prepareCall(String, ...)의 뒤. 돌려준 문장 객체에 SQL을 묶어 둔다.
// Hikari·log4jdbc 프록시 연결도 계측되므로, 앱이 받는 가장 바깥 문장 객체도 맵에 들어간다.
public final class PrepareAdvice {
  @Advice.OnMethodExit(suppress = Throwable.class)
  static void exit(@Advice.Argument(0) String sql, @Advice.Return Object stmt) {
    Tracer.remember(stmt, sql);
  }
}
