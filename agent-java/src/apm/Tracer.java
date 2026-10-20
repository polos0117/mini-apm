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
  static final int MAX_SQL = 100_000; // SQL 문장·URL 길이(문자). 한글이라도 약 300KB라 MAX_BODY 안에 든다
  static final int MAX_PARAM = 200;   // 바인드 값 하나의 길이(문자)
  static final int MAX_LAST = 1000;   // 처리 중 목록에 싣는 마지막 호출 길이(문자)
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
  // 외부 호출과 SQL은 서로 겹쳐 불리지 않으므로 같은 카운터를 쓴다.
  private static final ThreadLocal<int[]> DEPTH = ThreadLocal.withInitial(() -> new int[1]);
  // PreparedStatement는 SQL을 꺼낼 방법이 없어서, prepareStatement 때 문장 객체와 SQL을 묶어 둔다.
  private static final Map<Object, String> SQL = Collections.synchronizedMap(new WeakHashMap<Object, String>());
  // setXxx(번호, 값)로 넣은 바인드 값. 문장 객체 → (번호 → SQL에 넣을 모양)
  private static final Map<Object, Map<Integer, String>> PARAMS =
      Collections.synchronizedMap(new WeakHashMap<Object, Map<Integer, String>>());
  // connect()·getOutputStream()에서 먼저 연결한 HttpURLConnection → 아직 응답을 못 받은 구간.
  // getInputStream()이 이어 받아 연결·본문 전송·응답 헤더를 구간 하나로 잰다. 응답을 안 읽고 버린 연결은 GC가 치운다.
  private static final Map<Object, Span> PENDING = Collections.synchronizedMap(new WeakHashMap<Object, Span>());
  // 겹쳐 불리는 MyBatis Executor(CachingExecutor → SimpleExecutor) 가운데 바깥 한 번만
  private static final ThreadLocal<int[]> MAPPER = ThreadLocal.withInitial(() -> new int[1]);

  public static final class Tx {
    final String id = UUID.randomUUID().toString();
    final String name;
    final long start = System.currentTimeMillis();
    final long t0 = System.nanoTime();
    final Thread thread = Thread.currentThread(); // begin은 요청 스레드에서 불린다. 처리 중 위치를 읽을 때 쓴다
    final List<Span> spans = Collections.synchronizedList(new ArrayList<Span>());
    int dropped;
    int chars; // 담은 구간 글자 수. MAX_BODY를 넘으면 어차피 못 보내므로 더 담지 않는다(앱 힙 보호)
    int level; // 지금 열린 메서드·매퍼 구간 수
    String ip, user, referer, params; // 요청 정보(RequestInfo가 끝날 때 채운다)
    String route; // API별 통계의 묶음 이름(Spring 패턴). 없으면 수집 서버가 name으로 묶는다
    String firstError; // 앱이 남긴 첫 예외. 구간 한도로 예외 구간을 못 남겨도 요청 에러는 이것으로 정한다
    double elapsed;
    int status;
    String error;

    Tx(String name) {
      this.name = name;
    }
  }

  public static final class Span {
    final String type; // "sql", "http", "exception", "method", "mapper"
    final String text;
    final long t0 = System.nanoTime();
    final double offset;
    final int depth; // 열린 메서드·매퍼 구간 수(들여쓰기)
    double elapsed;
    String error;

    Span(String type, String text, double offset, int depth) {
      this.type = type;
      this.text = text;
      this.offset = offset;
      this.depth = depth;
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
    tx.error = tx.firstError; // 앱이 남긴 첫 예외가 원인에 가깝다
    synchronized (tx.spans) {
      if (tx.error == null && status >= 500) {
        tx.error = "HTTP " + status;
        for (Span s : tx.spans) { // 마지막으로 실패한 SQL·외부 구간
          if (s.error != null && ("sql".equals(s.type) || "http".equals(s.type))) tx.error = s.error;
        }
      }
    }
    synchronized (Tracer.class) {
      done.add(tx);
      if (done.size() > MAX_BUFFER) done.subList(0, done.size() - MAX_BUFFER).clear();
    }
  }

  // 요청이 끝날 때 RequestInfo가 정리해 넘긴다
  public static void request(Tx tx, String ip, String user, String referer, String params, String route) {
    tx.ip = ip;
    tx.user = user;
    tx.referer = cut(referer);
    tx.params = params;
    tx.route = cut(route);
  }

  public static void remember(Object stmt, String sql) {
    if (stmt != null && sql != null) SQL.put(stmt, sql);
  }

  // 구간 수·글자 수 한도를 넘었으면 개수만 센다
  private static boolean full(Tx tx) {
    if (tx.spans.size() < MAX_SPANS && tx.chars < MAX_BODY) return false;
    tx.dropped++;
    return true;
  }

  // 바깥 호출이고 요청 안이면 지금 트랜잭션을, 아니면 null. 깊이는 늘 올리고 짝이 되는 *End가 내린다.
  private static Tx outer() {
    if (DEPTH.get()[0]++ > 0) return null;
    Tx tx = CURRENT.get();
    return tx == null || full(tx) ? null : tx;
  }

  private static Span open(Tx tx, String type, String text) {
    Span s = new Span(type, text, ms(System.nanoTime() - tx.t0), tx.level);
    tx.chars += text.length();
    tx.spans.add(s);
    return s;
  }

  static String cut(String s) {
    return s != null && s.length() > MAX_SQL ? s.substring(0, MAX_SQL) : s;
  }

  // 예외 표시: 단순클래스명: 메시지
  public static String exceptionText(String className, String msg) {
    String simple = className.substring(className.lastIndexOf('.') + 1);
    return msg == null ? simple : simple + ": " + msg;
  }

  // 앱이 남긴 예외(ERROR 로그, printStackTrace). 요청 밖이면 버린다. SQL 깊이와 상관없이 기록한다.
  public static void exception(String text, String error) {
    try {
      Tx tx = CURRENT.get();
      if (tx == null) return;
      if (tx.firstError == null) tx.firstError = cut(error);
      if (full(tx)) return;
      open(tx, "exception", cut(text)).error = cut(error);
    } catch (Throwable ignored) {
      // 앱으로 새지 않게
    }
  }

  // Logback ERROR 이벤트. throwableClass가 null이면 예외 없는 로그
  public static void logError(String msg, String throwableClass, String throwableMsg) {
    String text = msg == null || msg.isEmpty() ? "(메시지 없음)" : msg;
    exception(text, throwableClass == null ? text : exceptionText(throwableClass, throwableMsg));
  }

  public static void printed(String throwableClass, String throwableMsg) {
    exception("printStackTrace()", exceptionText(throwableClass, throwableMsg));
  }

  // 메서드·매퍼 구간: 만들면 level을 올리고, 닫을 때 내린다. 요청 밖이거나 한도면 만들지 않는다.
  private static Span enter(String type, String text) {
    Tx tx = CURRENT.get();
    if (tx == null || full(tx)) return null;
    Span s = open(tx, type, text);
    tx.level++;
    return s;
  }

  private static void leave(Span s, Throwable thrown) {
    if (s == null) return;
    Tx tx = CURRENT.get();
    if (tx != null) tx.level--;
    s.elapsed = ms(System.nanoTime() - s.t0);
    if (thrown != null) s.error = exceptionText(thrown.getClass().getName(), thrown.getMessage());
  }

  public static Span methodStart(String typeName, String method) {
    try {
      return enter("method", typeName.substring(typeName.lastIndexOf('.') + 1) + "." + method);
    } catch (Throwable t) {
      return null;
    }
  }

  public static void methodEnd(Span s, Throwable thrown) {
    try {
      leave(s, thrown);
    } catch (Throwable ignored) {
      // 앱으로 새지 않게
    }
  }

  public static Span mapperStart(String statementId) {
    if (MAPPER.get()[0]++ > 0) return null;
    try {
      return enter("mapper", mapperName(statementId));
    } catch (Throwable t) {
      return null;
    }
  }

  public static void mapperEnd(Span s, Throwable thrown) {
    MAPPER.get()[0]--;
    methodEnd(s, thrown);
  }

  // org.kipa…EvlMapper.insertResult → EvlMapper.insertResult
  static String mapperName(String id) {
    int dot = id.lastIndexOf('.');
    if (dot < 0) return id;
    String ns = id.substring(0, dot);
    return ns.substring(ns.lastIndexOf('.') + 1) + id.substring(dot);
  }

  private static void close(Span s, String error) {
    DEPTH.get()[0]--;
    if (s == null) return;
    s.elapsed = ms(System.nanoTime() - s.t0);
    s.error = error;
  }

  static String message(Throwable t) {
    return t.getMessage() != null ? t.getMessage() : t.getClass().getName();
  }

  public static Span sqlStart(Object stmt, Object[] args) {
    try {
      Tx tx = outer();
      if (tx == null) return null; // 겹친 호출, 요청 밖의 SQL
      String sql;
      if (args.length > 0 && args[0] instanceof String) {
        sql = (String) args[0];
      } else {
        sql = SQL.get(stmt);
        Map<Integer, String> params = PARAMS.get(stmt);
        if (sql != null && params != null) sql = fill(sql, params);
      }
      return open(tx, "sql", sql == null ? "?" : normalize(sql));
    } catch (Throwable t) {
      return null;
    }
  }

  public static void sqlEnd(Span s, Throwable thrown) {
    close(s, thrown != null ? message(thrown) : null);
  }

  // url이 null이면 이미 응답을 받은 연결의 반복 호출이라 기록하지 않는다(깊이는 센다).
  public static Span httpStart(String method, String url) {
    try {
      Tx tx = outer();
      if (tx == null || url == null) return null;
      String text = method + " " + url;
      return open(tx, "http", text.length() > MAX_SQL ? text.substring(0, MAX_SQL) : text);
    } catch (Throwable t) {
      return null;
    }
  }

  // code: 응답 코드, 모르면 -1. 4xx는 Node 에이전트처럼 에러로 보지 않는다.
  public static void httpEnd(Span s, int code, Throwable thrown) {
    close(s, code >= 500 ? "HTTP " + code : code < 0 && thrown != null ? message(thrown) : null);
  }

  // connect()·getOutputStream() 뒤. 연결에 성공하면 구간을 열어 둔 채 PENDING에 맡기고, 실패하면 에러로 닫는다.
  public static void httpConnected(Object conn, Span s, Throwable thrown) {
    if (s != null && thrown == null) {
      DEPTH.get()[0]--;
      PENDING.put(conn, s);
    } else {
      httpEnd(s, -1, thrown);
    }
  }

  // getInputStream() 앞. 먼저 연결해 둔 구간이 있으면 새로 만들지 않고 잇는다.
  public static Span httpResume(Object conn, String method, String url) {
    if (url != null && DEPTH.get()[0] == 0) {
      Span s = PENDING.remove(conn);
      if (s != null) {
        DEPTH.get()[0]++;
        return s;
      }
    }
    return httpStart(method, url);
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
        for (int i = t.spans.size() - 1; i >= 0 && last == null; i--) { // 마지막 SQL·외부 호출(메서드·매퍼·예외 줄은 건너뜀)
          Span s = t.spans.get(i);
          if ("sql".equals(s.type) || "http".equals(s.type)) last = s.text;
        }
      }
      // 처리 중 목록은 매 전송에 실리므로 짧게. 멈춘 요청이 많아도 본문이 수집 서버 한도(1MB)를 넘지 않게 한다
      if (last != null && last.length() > MAX_LAST) last = last.substring(0, MAX_LAST) + "...";
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
        StringBuilder one = new StringBuilder(s.text.length() + 80).append("{\"type\":");
        str(one, s.type);
        one.append(",\"text\":");
        str(one, s.text);
        one.append(",\"offset\":");
        num(one, s.offset);
        one.append(",\"elapsed\":");
        num(one, s.elapsed);
        one.append(",\"error\":");
        str(one, s.error);
        one.append(",\"depth\":").append(s.depth);
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
    b.append(",\"route\":");
    str(b, t.route);
    b.append(",\"req\":{\"ip\":");
    str(b, t.ip);
    b.append(",\"user\":");
    str(b, t.user);
    b.append(",\"referer\":");
    str(b, t.referer);
    b.append(",\"params\":");
    str(b, t.params);
    b.append('}');
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
