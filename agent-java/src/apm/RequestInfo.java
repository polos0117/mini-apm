package apm;

import java.lang.reflect.Method;
import java.util.Locale;
import java.util.Map;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpSession;

// 요청이 끝날 때 사용자·IP·화면·파라미터를 문자열로 정리해 Tracer에 넘긴다. 서블릿 타입을 쓰므로 에이전트 jar에 둔다.
public final class RequestInfo {
  public static String userAttr = "loginUser"; // APM_USER_ATTR
  static final String[] SECRET = {"pass", "pw", "secret", "token", "jumin", "rrn", "ssn"};
  static final String[] USER_GETTERS = {"getUserId", "getUsername", "getLoginId", "getId"};
  static final int MAX_VALUE = 200;
  static final int MAX_PARAMS = 2000;
  static final String PATTERN_ATTR = "org.springframework.web.servlet.HandlerMapping.bestMatchingPattern";

  // 무엇이 실패해도 앱 응답과 트랜잭션 종료에 영향이 없게 모두 삼킨다
  public static void collect(Tracer.Tx tx, HttpServletRequest r) {
    if (tx == null) return;
    String ip = null, user = null, referer = null, params = null, route = null;
    try {
      ip = ip(r);
      referer = r.getHeader("Referer");
      params = params(r);
      user = user(r);
    } catch (Throwable ignored) {
      // 세션 무효화 등
    }
    try {
      route = route(r);
    } catch (Throwable ignored) {
      // 패턴을 못 읽으면 주소 그대로 묶인다
    }
    Tracer.request(tx, ip, user, referer, params, route);
  }

  // API별 통계의 묶음 이름. Spring이 고른 패턴이 실제 경로와 맞을 때만 "GET /ctx/qna/{procsCode}/list", 아니면 null
  static String route(HttpServletRequest r) {
    Object p = r.getAttribute(PATTERN_ATTR); // String 또는 Spring 5.3 PathPattern(toString이 패턴)
    if (p == null) return null;
    String pattern = p.toString();
    String ctx = r.getContextPath() == null ? "" : r.getContextPath();
    String uri = r.getRequestURI();
    if (uri == null || !uri.startsWith(ctx)) return null;
    return matches(pattern, uri.substring(ctx.length())) ? r.getMethod() + " " + ctx + pattern : null;
  }

  // 와일드카드(/** 등)가 없고, 조각 수가 같고, 조각마다 글자가 같거나 {변수}. 에러로 /error에 넘어간 요청도 여기서 걸러진다
  static boolean matches(String pattern, String path) {
    if (pattern.indexOf('*') >= 0 || pattern.indexOf('?') >= 0) return false;
    String[] a = pattern.split("/"), b = path.split("/");
    if (a.length != b.length) return false;
    for (int i = 0; i < a.length; i++) {
      boolean var = a[i].startsWith("{") && a[i].endsWith("}");
      if (!var && !a[i].equals(b[i])) return false;
    }
    return true;
  }

  static String ip(HttpServletRequest r) {
    String xff = r.getHeader("X-Forwarded-For");
    if (xff != null && !xff.trim().isEmpty()) return xff.split(",")[0].trim();
    return r.getRemoteAddr();
  }

  static String user(HttpServletRequest r) throws Exception {
    HttpSession s = r.getSession(false);
    if (s == null) return null;
    Object ctx = s.getAttribute("SPRING_SECURITY_CONTEXT");
    Object auth = ctx == null ? null : call(ctx, "getAuthentication");
    Object name = auth == null ? null : call(auth, "getName");
    if (name != null) return name.toString();
    Object u = s.getAttribute(userAttr);
    if (u == null || u instanceof String) return (String) u;
    for (String g : USER_GETTERS) {
      Method m = method(u, g);
      if (m != null) {
        Object v = m.invoke(u);
        return v == null ? null : v.toString();
      }
    }
    return null;
  }

  static String params(HttpServletRequest r) {
    StringBuilder b = new StringBuilder();
    for (Map.Entry<String, String[]> e : r.getParameterMap().entrySet()) {
      boolean secret = isSecret(e.getKey());
      for (String v : e.getValue()) {
        if (b.length() > 0) b.append('&');
        b.append(e.getKey()).append('=');
        b.append(secret ? "****" : v.length() > MAX_VALUE ? v.substring(0, MAX_VALUE) + "..." : v);
        if (b.length() > MAX_PARAMS) return b.substring(0, MAX_PARAMS) + "...";
      }
    }
    return b.length() == 0 ? null : b.toString();
  }

  static boolean isSecret(String name) {
    String n = name.toLowerCase(Locale.ROOT);
    for (String s : SECRET) if (n.contains(s)) return true;
    return false;
  }

  static Method method(Object o, String name) {
    try {
      Method m = o.getClass().getMethod(name);
      m.setAccessible(true); // 공개 클래스가 아니어도 부를 수 있게
      return m;
    } catch (NoSuchMethodException e) {
      return null;
    }
  }

  static Object call(Object o, String name) throws Exception {
    Method m = method(o, name);
    return m == null ? null : m.invoke(o);
  }
}
