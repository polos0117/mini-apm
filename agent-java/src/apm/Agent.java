package apm;

import java.lang.instrument.Instrumentation;

// 미니 APM Java 에이전트. `-javaagent:mini-apm-agent.jar`로 앱의 main보다 먼저 실행된다.
// JENNIFER의 -javaagent처럼, 앱 클래스가 로드될 때 바이트코드에 계측 코드를 끼워 넣는다.
public final class Agent {
  public static void premain(String args, Instrumentation inst) {
    String collector = env("APM_COLLECTOR", "http://localhost:7700");
    String agent = env("APM_AGENT", "java");
    System.out.println("[apm] mini-apm agent → " + collector + " (" + agent + ")");
  }

  private static String env(String key, String def) {
    String v = System.getenv(key);
    return v == null || v.isEmpty() ? def : v;
  }
}
