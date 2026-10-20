package apm;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import net.bytebuddy.asm.Advice;

// Tomcat StandardHostValve.invoke(Request, Response)의 앞뒤. 이 메서드들의 몸체가 대상 메서드 안으로 복사된다.
// HttpServlet.service보다 바깥이라 Spring Security 필터 시간까지 응답시간에 들어간다.
public final class RequestAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Tx enter(@Advice.Argument(0) HttpServletRequest req) {
    return Tracer.begin(req.getMethod(), req.getRequestURI());
  }

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Tx tx, @Advice.Argument(0) HttpServletRequest req,
      @Advice.Argument(1) HttpServletResponse res, @Advice.Thrown Throwable thrown) {
    RequestInfo.collect(tx, req); // 예외를 삼키므로 아래 end는 늘 불린다
    Tracer.end(tx, thrown != null ? 500 : res.getStatus());
  }
}
