package apm;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

// 트랜잭션과 구간을 기록하고 1초마다 수집 서버로 보낸다. 형식은 Node 에이전트(agent/index.js)와 같다.
// Advice가 대상 클래스 안으로 복사한 코드가 이 클래스의 public static 메서드를 부른다.
public final class Tracer {
  static final int MAX_SPANS = 1000;  // 트랜잭션당 기록할 구간 수. 넘으면 개수만 센다
  static final int MAX_BUFFER = 5000; // 전송 대기 트랜잭션 수
  static final int MAX_SQL = 1000;    // SQL 문장 길이. 큰 SQL 1000개가 수집 서버 1MB 한도를 넘지 않게
  static final Set<String> STATIC_EXT = new HashSet<>(Arrays.asList(
      "js", "css", "png", "jpg", "gif", "svg", "ico", "woff", "woff2", "map"));

  public static String collector = "http://localhost:7700";
  public static String agent = "java";

  // Tomcat은 요청 하나를 스레드 하나가 끝까지 처리하므로 '지금 어느 트랜잭션인가'는 스레드에 둔다.
  private static final ThreadLocal<Tx> CURRENT = new ThreadLocal<>();
  private static final Map<String, Tx> OPEN = new ConcurrentHashMap<>(); // 처리 중
  private static List<Tx> done = new ArrayList<>();                     // 전송 대기. Tracer.class로 잠근다
  private static boolean failing;                                        // 전송 스레드만 쓴다

  public static final class Tx {
    final String id = UUID.randomUUID().toString();
    final String name;
    final long start = System.currentTimeMillis();
    final long t0 = System.nanoTime();
    final List<Span> spans = Collections.synchronizedList(new ArrayList<Span>());
    int dropped;
    double elapsed;
    int status;
    String error;

    Tx(String name) {
      this.name = name;
    }
  }

  public static final class Span {
    final String text;
    final long t0 = System.nanoTime();
    final double offset;
    double elapsed;
    String error;

    Span(String text, double offset) {
      this.text = text;
      this.offset = offset;
    }
  }

  static double ms(long nanos) {
    return Math.round(nanos / 100_000.0) / 10.0; // 소수 첫째 자리
  }

  static boolean isStatic(String uri) {
    int dot = uri.lastIndexOf('.');
    return dot > uri.lastIndexOf('/') && STATIC_EXT.contains(uri.substring(dot + 1).toLowerCase(Locale.ROOT));
  }

  public static Tx begin(String method, String uri) {
    try {
      if (CURRENT.get() != null) return null; // 같은 스레드에서 다시 불려도 요청당 한 번만
      int semi = uri.indexOf(';'); // ;jsessionid=...
      if (semi >= 0) uri = uri.substring(0, semi);
      if (isStatic(uri)) return null;
      Tx tx = new Tx(method + " " + uri);
      CURRENT.set(tx);
      OPEN.put(tx.id, tx);
      return tx;
    } catch (Throwable t) {
      return null;
    }
  }

  public static void end(Tx tx, int status) {
    if (tx == null) return;
    CURRENT.remove();
    OPEN.remove(tx.id);
    tx.elapsed = ms(System.nanoTime() - tx.t0);
    tx.status = status;
    if (status >= 500) {
      tx.error = "HTTP " + status;
      synchronized (tx.spans) {
        for (Span s : tx.spans) if (s.error != null) tx.error = s.error; // 마지막으로 실패한 구간
      }
    }
    synchronized (Tracer.class) {
      done.add(tx);
      if (done.size() > MAX_BUFFER) done.subList(0, done.size() - MAX_BUFFER).clear();
    }
  }

  public static void startSender(final long intervalMs) {
    Thread t = new Thread(() -> {
      while (true) {
        try {
          Thread.sleep(intervalMs);
        } catch (InterruptedException e) {
          return;
        }
        flush();
      }
    }, "apm-sender");
    t.setDaemon(true);
    t.start();
  }

  static void flush() {
    List<Tx> batch;
    synchronized (Tracer.class) {
      batch = done;
      done = new ArrayList<>();
    }
    byte[] body = payload(batch, OPEN.values(), System.nanoTime()).getBytes(StandardCharsets.UTF_8);
    try {
      HttpURLConnection c = (HttpURLConnection) new URL(collector + "/ingest").openConnection();
      c.setConnectTimeout(1000);
      c.setReadTimeout(1000);
      c.setRequestMethod("POST");
      c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/json");
      try (OutputStream out = c.getOutputStream()) {
        out.write(body);
      }
      int code = c.getResponseCode();
      c.disconnect();
      if (code >= 400) throw new IOException("HTTP " + code);
      failing = false;
    } catch (Exception e) { // 그 묶음은 버린다
      if (!failing) System.err.println("[apm] 전송 실패: " + e);
      failing = true;
    }
  }

  // ---- JSON: 앱의 Jackson 버전과 부딪히지 않게 직접 쓴다 ----

  static String payload(List<Tx> txs, Collection<Tx> open, long now) {
    StringBuilder b = new StringBuilder(1024).append("{\"agent\":");
    str(b, agent);
    b.append(",\"txs\":[");
    for (int i = 0; i < txs.size(); i++) {
      if (i > 0) b.append(',');
      tx(b, txs.get(i));
    }
    b.append("],\"active\":[");
    boolean first = true;
    for (Tx t : open) {
      if (!first) b.append(',');
      first = false;
      String last = null;
      synchronized (t.spans) {
        if (!t.spans.isEmpty()) last = t.spans.get(t.spans.size() - 1).text;
      }
      b.append("{\"id\":");
      str(b, t.id);
      b.append(",\"name\":");
      str(b, t.name);
      b.append(",\"elapsed\":");
      num(b, ms(now - t.t0));
      b.append(",\"lastSpan\":");
      str(b, last);
      b.append('}');
    }
    return b.append("]}").toString();
  }

  static void tx(StringBuilder b, Tx t) {
    b.append("{\"id\":");
    str(b, t.id);
    b.append(",\"name\":");
    str(b, t.name);
    b.append(",\"start\":").append(t.start).append(",\"elapsed\":");
    num(b, t.elapsed);
    b.append(",\"status\":").append(t.status).append(",\"error\":");
    str(b, t.error);
    if (t.dropped > 0) b.append(",\"droppedSpans\":").append(t.dropped);
    b.append(",\"spans\":[");
    synchronized (t.spans) {
      for (int i = 0; i < t.spans.size(); i++) {
        Span s = t.spans.get(i);
        if (i > 0) b.append(',');
        b.append("{\"type\":\"sql\",\"text\":");
        str(b, s.text);
        b.append(",\"offset\":");
        num(b, s.offset);
        b.append(",\"elapsed\":");
        num(b, s.elapsed);
        b.append(",\"error\":");
        str(b, s.error);
        b.append('}');
      }
    }
    b.append("]}");
  }

  static void str(StringBuilder b, String s) {
    if (s == null) {
      b.append("null");
      return;
    }
    b.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"') b.append("\\\"");
      else if (c == '\\') b.append("\\\\");
      else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    b.append('"');
  }

  static void num(StringBuilder b, double d) {
    b.append(Double.isNaN(d) || Double.isInfinite(d) ? 0 : d);
  }
}
