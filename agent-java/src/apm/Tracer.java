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
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.ConcurrentHashMap;

// 트랜잭션과 구간을 기록하고 1초마다 수집 서버로 보낸다. 형식은 Node 에이전트(agent/index.js)와 같다.
// Advice가 대상 클래스 안으로 복사한 코드가 이 클래스의 public static 메서드를 부른다.
public final class Tracer {
  static final int MAX_SPANS = 1000;  // 트랜잭션당 기록할 구간 수. 넘으면 개수만 센다
  static final int MAX_BUFFER = 5000; // 전송 대기 트랜잭션 수
  static final int MAX_SQL = 1000;    // SQL 문장 길이(문자)
  static final int MAX_PARAM = 200;   // 바인드 값 하나의 길이(문자)
  static final int MAX_BODY = 900_000; // 한 번에 보내는 바이트. 수집 서버 한도(1MB)보다 여유 있게
  static final Set<String> STATIC_EXT = new HashSet<>(Arrays.asList(
      "js", "css", "png", "jpg", "gif", "svg", "ico", "woff", "woff2", "map"));

  public static String collector = "http://localhost:7700";
  public static String agent = "java";
  public static String appPackage; // 앱 클래스 이름 접두어(예: org.kipa.ipfinance.). null이면 모른다

  // Tomcat은 요청 하나를 스레드 하나가 끝까지 처리하므로 '지금 어느 트랜잭션인가'는 스레드에 둔다.
  private static final ThreadLocal<Tx> CURRENT = new ThreadLocal<>();
  private static final Map<String, Tx> OPEN = new ConcurrentHashMap<>(); // 처리 중
  private static List<Tx> done = new ArrayList<>();                     // 전송 대기. Tracer.class로 잠근다
  private static boolean failing;                                        // 전송 스레드만 쓴다
  // SQL은 Hikari 프록시 → log4jdbc → 드라이버로 겹쳐 불린다. 가장 바깥 호출만 기록하려고 스레드별 깊이를 센다.
  private static final ThreadLocal<int[]> DEPTH = ThreadLocal.withInitial(() -> new int[1]);
  // PreparedStatement는 SQL을 꺼낼 방법이 없어서, prepareStatement 때 문장 객체와 SQL을 묶어 둔다.
  private static final Map<Object, String> SQL = Collections.synchronizedMap(new WeakHashMap<Object, String>());
  // setXxx(번호, 값)로 넣은 바인드 값. 문장 객체 → (번호 → SQL에 넣을 모양)
  private static final Map<Object, Map<Integer, String>> PARAMS =
      Collections.synchronizedMap(new WeakHashMap<Object, Map<Integer, String>>());

  public static final class Tx {
    final String id = UUID.randomUUID().toString();
    final String name;
    final long start = System.currentTimeMillis();
    final long t0 = System.nanoTime();
    final Thread thread = Thread.currentThread(); // begin은 요청 스레드에서 불린다. 처리 중 위치를 읽을 때 쓴다
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

  public static void remember(Object stmt, String sql) {
    if (stmt != null && sql != null) SQL.put(stmt, sql);
  }

  public static Span sqlStart(Object stmt, Object[] args) {
    int[] depth = DEPTH.get();
    if (depth[0]++ > 0) return null;
    try {
      Tx tx = CURRENT.get();
      if (tx == null) return null; // 요청 밖의 SQL
      if (tx.spans.size() >= MAX_SPANS) {
        tx.dropped++;
        return null;
      }
      String sql;
      if (args.length > 0 && args[0] instanceof String) {
        sql = (String) args[0];
      } else {
        sql = SQL.get(stmt);
        Map<Integer, String> params = PARAMS.get(stmt);
        if (sql != null && params != null) sql = fill(sql, params);
      }
      Span s = new Span(sql == null ? "?" : normalize(sql), ms(System.nanoTime() - tx.t0));
      tx.spans.add(s);
      return s;
    } catch (Throwable t) {
      return null;
    }
  }

  public static void sqlEnd(Span s, Throwable thrown) {
    DEPTH.get()[0]--;
    if (s == null) return;
    s.elapsed = ms(System.nanoTime() - s.t0);
    if (thrown != null) s.error = thrown.getMessage() != null ? thrown.getMessage() : thrown.getClass().getName();
  }

  // setXxx(번호, 값) 또는 clearParameters(). 같은 문장 객체는 한 스레드가 쓰므로 안쪽 맵은 잠그지 않는다.
  public static void bind(Object stmt, String method, Object[] args) {
    if ("clearParameters".equals(method)) {
      PARAMS.remove(stmt);
      return;
    }
    Map<Integer, String> params;
    synchronized (PARAMS) {
      params = PARAMS.get(stmt);
      if (params == null) PARAMS.put(stmt, params = new HashMap<>());
    }
    params.put((Integer) args[0], literal("setNull".equals(method) ? null : args[1]));
  }

  // 바인드 값을 SQL에 그대로 넣을 수 있는 모양으로 (log4jdbc 로그와 같은 모양)
  static String literal(Object v) {
    if (v == null) return "NULL";
    if (v instanceof byte[]) return "<byte[" + ((byte[]) v).length + "]>";
    String s;
    if (v instanceof Number || v instanceof Boolean) {
      s = v.toString();
    } else if (v instanceof CharSequence || v instanceof Character || v instanceof java.util.Date
        || v instanceof java.time.temporal.Temporal) {
      s = "'" + v.toString().replace("'", "''") + "'";
    } else {
      return "<" + v.getClass().getSimpleName() + ">"; // Blob, 스트림 등
    }
    return s.length() > MAX_PARAM ? s.substring(0, MAX_PARAM) + "..." : s;
  }

  // ?를 번호 순서대로 값으로 바꾼다. 작은따옴표 안의 ?는 문자열의 일부라 그대로 둔다.
  static String fill(String sql, Map<Integer, String> params) {
    StringBuilder b = new StringBuilder(sql.length() + 64);
    boolean quoted = false;
    int n = 0;
    for (int i = 0; i < sql.length(); i++) {
      char c = sql.charAt(i);
      if (c == '\'') quoted = !quoted;
      if (c == '?' && !quoted) {
        String v = params.get(++n);
        b.append(v != null ? v : "?");
      } else {
        b.append(c);
      }
    }
    return b.toString();
  }

  static String normalize(String sql) {
    String s = sql.replaceAll("\\s+", " ").trim();
    return s.length() > MAX_SQL ? s.substring(0, MAX_SQL) : s;
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

  // 수집 서버는 1MB가 넘는 본문을 통째로 거절한다. 그래서 MAX_BODY 단위로 나눠 보내고,
  // 혼자서도 넘는 트랜잭션은 뒤쪽 구간을 잘라 droppedSpans로 센다.
  static void flush() {
    List<Tx> batch;
    synchronized (Tracer.class) {
      batch = done;
      done = new ArrayList<>();
    }
    String active = active(OPEN.values(), System.nanoTime());
    int room = MAX_BODY - utf8(active) - utf8(agent) - 64;
    StringBuilder txs = new StringBuilder();
    int bytes = 0;
    for (Tx t : batch) {
      String json = tx(t, room);
      int n = utf8(json) + 1;
      if (bytes > 0 && bytes + n > room) {
        post(txs, active);
        txs.setLength(0);
        bytes = 0;
      }
      if (bytes > 0) txs.append(',');
      txs.append(json);
      bytes += n;
    }
    post(txs, active); // 트랜잭션이 없어도 처리 중 목록은 보낸다
  }

  static void post(CharSequence txs, String active) {
    StringBuilder b = new StringBuilder(txs.length() + active.length() + 64).append("{\"agent\":");
    str(b, agent);
    b.append(",\"txs\":[").append(txs).append("],\"active\":").append(active).append('}');
    byte[] body = b.toString().getBytes(StandardCharsets.UTF_8);
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

  static int utf8(String s) {
    return s.getBytes(StandardCharsets.UTF_8).length;
  }

  // ---- JSON: 앱의 Jackson 버전과 부딪히지 않게 직접 쓴다 ----

  // 처리 중 요청이 지금 어디서 멈춰 있는지: 첫 앱 프레임(줄 번호 포함)과, 다르면 맨 위 프레임.
  // 예: EvlServiceImpl.selectList:120 → SocketInputStream.socketRead0
  static String where(StackTraceElement[] st) {
    if (st.length == 0) return null;
    StackTraceElement app = null;
    if (appPackage != null) {
      for (StackTraceElement e : st) {
        String c = e.getClassName();
        if (c.startsWith(appPackage) && !c.contains("$$")) { // $$: CGLIB 프록시
          app = e;
          break;
        }
      }
    }
    String top = simple(st[0]);
    if (app == null) return top;
    String a = simple(app) + ":" + app.getLineNumber();
    return app == st[0] ? a : a + " → " + top;
  }

  static String simple(StackTraceElement e) {
    String c = e.getClassName();
    return c.substring(c.lastIndexOf('.') + 1) + "." + e.getMethodName();
  }

  static String active(Collection<Tx> open, long now) {
    StringBuilder b = new StringBuilder(256).append('[');
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
      b.append(",\"where\":");
      str(b, where(t.thread.getStackTrace()));
      b.append('}');
    }
    return b.append(']').toString();
  }

  // 구간은 budget 바이트 안에 드는 데까지만 담고 나머지는 droppedSpans에 더한다.
  static String tx(Tx t, int budget) {
    StringBuilder spans = new StringBuilder();
    int left = budget - utf8(t.name) - 300; // 300: 구간 밖 필드 몫
    int kept = 0;
    int dropped;
    synchronized (t.spans) {
      for (Span s : t.spans) {
        StringBuilder one = new StringBuilder(s.text.length() + 80).append("{\"type\":\"sql\",\"text\":");
        str(one, s.text);
        one.append(",\"offset\":");
        num(one, s.offset);
        one.append(",\"elapsed\":");
        num(one, s.elapsed);
        one.append(",\"error\":");
        str(one, s.error);
        one.append('}');
        String json = one.toString();
        left -= utf8(json) + 1;
        if (left < 0) break;
        if (kept++ > 0) spans.append(',');
        spans.append(json);
      }
      dropped = t.dropped + t.spans.size() - kept;
    }
    StringBuilder b = new StringBuilder(spans.length() + 256).append("{\"id\":");
    str(b, t.id);
    b.append(",\"name\":");
    str(b, t.name);
    b.append(",\"start\":").append(t.start).append(",\"elapsed\":");
    num(b, t.elapsed);
    b.append(",\"status\":").append(t.status).append(",\"error\":");
    str(b, t.error);
    if (dropped > 0) b.append(",\"droppedSpans\":").append(dropped);
    return b.append(",\"spans\":[").append(spans).append("]}").toString();
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
