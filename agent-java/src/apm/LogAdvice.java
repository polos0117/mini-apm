package apm;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import net.bytebuddy.asm.Advice;

// Logback Logger.callAppenders(이벤트) 앞. 레벨 판단을 통과한 로그만, 한 건당 한 번 불린다. ERROR만 예외로 남긴다.
// Spring Boot가 Tomcat(java.util.logging)의 "처리 안 된 예외" 로그도 Logback으로 넘기므로 그것도 여기로 온다.
public final class LogAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static void enter(@Advice.Argument(0) ILoggingEvent e) {
    if (e.getLevel().toInt() != Level.ERROR_INT) return;
    IThrowableProxy t = e.getThrowableProxy();
    Tracer.logError(e.getFormattedMessage(), t == null ? null : t.getClassName(), t == null ? null : t.getMessage());
  }
}
