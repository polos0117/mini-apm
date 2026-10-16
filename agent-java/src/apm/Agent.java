package apm;

import static net.bytebuddy.matcher.ElementMatchers.isAbstract;
import static net.bytebuddy.matcher.ElementMatchers.isInterface;
import static net.bytebuddy.matcher.ElementMatchers.isSubTypeOf;
import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.nameStartsWith;
import static net.bytebuddy.matcher.ElementMatchers.namedOneOf;
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
    long interval = 1000;
    try {
      interval = Long.parseLong(env("APM_INTERVAL", "1000"));
    } catch (NumberFormatException ignored) {
      // 기본값을 쓴다
    }
    System.out.println("[apm] mini-apm agent → " + Tracer.collector + " (" + Tracer.agent + ")");

    new AgentBuilder.Default()
        .with(new AgentBuilder.Listener.Adapter() {
          @Override
          public void onError(String type, ClassLoader loader, JavaModule module, boolean loaded, Throwable t) {
            // ponytail: 대상인지 이름으로만 거른다. 하위 타입 판정 중 무관한 클래스에서 나는 오류는 숨긴다.
            if (type.endsWith("StandardHostValve") || type.contains("Statement") || type.contains("Connection")) {
              System.err.println("[apm] 계측 실패: " + type + " " + t);
            }
          }
        })
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
        .installOn(inst);

    Tracer.startSender(interval);
  }

  private static String env(String key, String def) {
    String v = System.getenv(key);
    return v == null || v.isEmpty() ? def : v;
  }
}
