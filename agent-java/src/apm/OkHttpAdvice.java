package apm;

import net.bytebuddy.asm.Advice;
import okhttp3.Call;
import okhttp3.Response;

// OkHttp RealCall.execute()(동기 호출) 앞뒤. Tracer는 OkHttp 타입을 모르므로 문자열과 응답 코드만 넘긴다.
public final class OkHttpAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Span enter(@Advice.This Call call) {
    return Tracer.httpStart(call.request().method(), call.request().url().toString());
  }

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Span span, @Advice.Return Response res, @Advice.Thrown Throwable thrown) {
    Tracer.httpEnd(span, res != null ? res.code() : -1, thrown);
  }
}
