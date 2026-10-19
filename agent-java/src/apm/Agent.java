package apm;

import static net.bytebuddy.matcher.ElementMatchers.isAbstract;
import static net.bytebuddy.matcher.ElementMatchers.isInterface;
import static net.bytebuddy.matcher.ElementMatchers.isSubTypeOf;
import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.nameStartsWith;
import static net.bytebuddy.matcher.ElementMatchers.namedOneOf;
import static net.bytebuddy.matcher.ElementMatchers.none;
import static net.bytebuddy.matcher.ElementMatchers.not;
import static net.bytebuddy.matcher.ElementMatchers.takesArgument;
import static net.bytebuddy.matcher.ElementMatchers.takesArguments;

import java.lang.instrument.Instrumentation;
import java.sql.Connection;
import java.sql.Statement;
import net.bytebuddy.agent.builder.AgentBuilder;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.utility.JavaModule;

// 미니 APM Java 에이전트. `-javaagent:mini-apm-agent.jar`로 앱의 main보다 먼저 실행된다.
// JENNIFER의 -javaagent처럼, 앱 클래스가 로드될 때 바이트코드에 계측 코드를 끼워 넣는다.
public final class Agent {
  public static void premain(String args, Instrumentation inst) {
    Tracer.collector = env("APM_COLLECTOR", Tracer.collector);
    Tracer.agent = env("APM_AGENT", Tracer.agent);
    Tracer.appPackage = env("APM_APP_PACKAGE", mainPackage(System.getProperty("sun.java.command")));
    long interval = 1000;
    try {
      interval = Long.parseLong(env("APM_INTERVAL", "1000"));
    } catch (NumberFormatException ignored) {
      // 기본값을 쓴다
    }
    System.out.println("[apm] mini-apm agent → " + Tracer.collector + " (" + Tracer.agent + ", 앱 패키지 "
        + (Tracer.appPackage == null ? "없음" : Tracer.appPackage) + ")");

    AgentBuilder.Listener errors = new AgentBuilder.Listener.Adapter() {
      @Override
      public void onError(String type, ClassLoader loader, JavaModule module, boolean loaded, Throwable t) {
        // ponytail: 대상인지 이름으로만 거른다. 하위 타입 판정 중 무관한 클래스에서 나는 오류는 숨긴다.
        if (type.endsWith("StandardHostValve") || type.contains("Statement") || type.contains("Connection")
            || type.endsWith("RealCall")) {
          System.err.println("[apm] 계측 실패: " + type + " " + t);
        }
      }
    };

    new AgentBuilder.Default()
        .with(errors)
        .type(named("org.apache.catalina.core.StandardHostValve"))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(RequestAdvice.class).on(named("invoke").and(takesArguments(2)))))
        // 추상 클래스도 포함한다. Hikari의 ProxyPreparedStatement·ProxyConnection은 추상 클래스지만 실행 메서드를 직접 구현한다.
        .type(isSubTypeOf(Statement.class).and(not(isInterface())))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(SqlAdvice.class).on(not(isAbstract()).and(namedOneOf(
                "execute", "executeQuery", "executeUpdate", "executeBatch", "executeLargeUpdate", "executeLargeBatch"))))
                // 바인드 값: setXxx(번호, 값[, ...])와 clearParameters(). setFetchSize(int) 같은 인자 하나짜리는 빠진다.
                .visit(Advice.to(BindAdvice.class).on(not(isAbstract()).and(named("clearParameters")
                    .or(nameStartsWith("set").and(takesArgument(0, int.class))
                        .and(takesArguments(2).or(takesArguments(3))))))))
        .type(isSubTypeOf(Connection.class).and(not(isInterface())))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(PrepareAdvice.class).on(not(isAbstract())
                .and(namedOneOf("prepareStatement", "prepareCall")).and(takesArgument(0, String.class)))))
        // OkHttp 동기 호출. 3.x는 okhttp3.RealCall, 4.x는 okhttp3.internal.connection.RealCall(4.x는 테스트하지 않음)
        .type(namedOneOf("okhttp3.RealCall", "okhttp3.internal.connection.RealCall"))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(OkHttpAdvice.class).on(named("execute").and(takesArguments(0)))))
        .installOn(inst);

    // JDK의 HttpURLConnection은 부트스트랩 로더가 올린다. 기본 무시 규칙(부트스트랩 제외)을 풀고 이름이 같은 이 클래스 하나만,
    // 이미 로드됐어도 다시 변환한다. 위 빌더와 나눠서 SQL 쪽 매칭(MyBatis 부트스트랩 프록시 제외)은 그대로 둔다.
    // Advice가 부르는 Tracer는 Boot-Class-Path(mini-apm-boot.jar)로 부트스트랩에서 보인다.
    new AgentBuilder.Default()
        .disableClassFormatChanges()
        .ignore(none())
        .with(errors)
        .with(AgentBuilder.RedefinitionStrategy.RETRANSFORMATION)
        .type(named("sun.net.www.protocol.http.HttpURLConnection"))
        .transform((builder, type, loader, module) ->
            builder.visit(Advice.to(HttpAdvice.class).on(named("getInputStream").and(takesArguments(0))))
                .visit(Advice.to(ConnectAdvice.class).on(namedOneOf("connect", "getOutputStream").and(takesArguments(0)))))
        .installOn(inst);

    Tracer.startSender(interval);
  }

  private static String env(String key, String def) {
    String v = System.getenv(key);
    return v == null || v.isEmpty() ? def : v;
  }

  // main 클래스의 패키지 + '.'. Tomcat Bootstrap, fat jar 런처, -jar, 패키지 없는 main이면 모른다(null).
  static String mainPackage(String command) {
    if (command == null || command.trim().isEmpty()) return null;
    String main = command.trim().split("\\s+")[0];
    int dot = main.lastIndexOf('.');
    if (dot < 0 || main.endsWith(".jar") || main.startsWith("org.apache.")
        || main.startsWith("org.springframework.boot.loader.")) return null;
    return main.substring(0, dot + 1);
  }
}
