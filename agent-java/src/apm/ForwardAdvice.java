package apm;

import javax.servlet.ServletRequest;
import javax.servlet.http.HttpServletRequest;
import net.bytebuddy.asm.Advice;

// Tomcat ApplicationDispatcher.forward(요청, 응답) 진입. 예외·sendError로 /error에 넘어가면 Spring이 패턴을 "/error"로 덮으므로,
// 넘어가기 직전의 패턴으로 route를 먼저 정해 둔다(내장 Tomcat의 에러 페이지와 WAR의 ErrorPageFilter 모두 여기를 지난다).
public final class ForwardAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static void enter(@Advice.Argument(0) ServletRequest req) {
    if (req instanceof HttpServletRequest) Tracer.keepRoute(RequestInfo.route((HttpServletRequest) req));
  }
}
