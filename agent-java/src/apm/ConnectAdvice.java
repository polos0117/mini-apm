package apm;

import java.net.HttpURLConnection;
import net.bytebuddy.asm.Advice;

// JDK HttpURLConnection의 connect()·getOutputStream() 앞뒤. RestTemplate과 POST 호출은 여기서 먼저 연결한다.
// 아직 연결 전일 때만 구간을 연다. 실패하면 여기서 에러로 닫고, 성공하면 getInputStream()(HttpAdvice)이 이어 받는다.
public final class ConnectAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Span enter(@Advice.This HttpURLConnection c, @Advice.FieldValue("connected") boolean connected) {
    return Tracer.httpStart(c.getRequestMethod(), connected ? null : String.valueOf(c.getURL()));
  }

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.This HttpURLConnection c, @Advice.Enter Tracer.Span span, @Advice.Thrown Throwable thrown) {
    Tracer.httpConnected(c, span, thrown);
  }
}
