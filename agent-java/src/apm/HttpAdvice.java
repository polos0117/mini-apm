package apm;

import java.io.InputStream;
import java.net.HttpURLConnection;
import net.bytebuddy.asm.Advice;

// JDK의 sun.net.www.protocol.http.HttpURLConnection.getInputStream() 앞뒤. 응답 헤더를 받을 때까지가 구간의 끝이다.
// 앞서 connect()·getOutputStream()으로 연결했으면 그때 연 구간(ConnectAdvice)을 잇고, 아니면 여기서 연결부터 잰다.
// getResponseCode()도 이 메서드를 거치고, https는 이 클래스를 상속한 위임 객체가 부른다.
public final class HttpAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Span enter(@Advice.This HttpURLConnection c,
      @Advice.FieldValue("inputStream") InputStream cached,
      @Advice.FieldValue("rememberedException") Exception remembered) {
    // 이미 응답을 받았거나 실패한 연결은 저장해 둔 결과를 돌려줄 뿐이라 기록하지 않는다
    boolean repeat = cached != null || remembered != null;
    return Tracer.httpResume(c, c.getRequestMethod(), repeat ? null : String.valueOf(c.getURL()));
  }

  // 응답 코드는 필드에서 읽는다. getResponseCode()를 다시 부르면 실패한 연결을 재시도할 수 있다.
  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Span span, @Advice.FieldValue("responseCode") int code,
      @Advice.Thrown Throwable thrown) {
    Tracer.httpEnd(span, code, thrown);
  }
}
