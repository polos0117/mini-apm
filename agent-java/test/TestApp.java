import java.io.File;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.URL;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import javax.servlet.ServletException;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.apache.catalina.Context;
import org.apache.catalina.startup.Tomcat;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

// 에이전트 테스트용 앱: 내장 Tomcat + Derby 메모리 DB. 인자는 포트 하나.
public class TestApp {
  static final Logger log = LoggerFactory.getLogger(TestApp.class);

  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(args[0]);
    String stub = args.length > 1 ? args[1] : ""; // 외부 호출 대상(Node 테스트의 가짜 서버)
    Connection db = DriverManager.getConnection("jdbc:derby:memory:t;create=true");
    try (Statement s = db.createStatement()) { // 요청 밖의 SQL: 기록되면 안 된다
      s.execute("create table item (id int, name varchar(20))");
      s.execute("insert into item values (1, 'a')");
    }

    org.apache.ibatis.session.Configuration mybatis = new org.apache.ibatis.session.Configuration(
        new org.apache.ibatis.mapping.Environment("t", new org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory(),
            new org.apache.ibatis.datasource.unpooled.UnpooledDataSource(
                "org.apache.derby.jdbc.EmbeddedDriver", "jdbc:derby:memory:t", null, null)));
    mybatis.addMapper(TestAppItemMapper.class);
    TestAppOrderController orders = new TestAppOrderController(new TestAppOrderServiceImpl(
        new org.apache.ibatis.session.SqlSessionFactoryBuilder().build(mybatis)));
    log.error("기동 중 에러"); // 요청 밖: 기록되면 안 된다
    Tomcat tomcat = new Tomcat();
    tomcat.setPort(port);
    tomcat.setBaseDir(new File(System.getProperty("java.io.tmpdir"), "apm-testapp-" + port).getPath());
    tomcat.getConnector(); // Tomcat 9는 이 호출로 기본 커넥터를 만든다
    Context ctx = tomcat.addContext("", null);
    Tomcat.addServlet(ctx, "app", new HttpServlet() {
      @Override
      protected void doGet(HttpServletRequest req, HttpServletResponse res) throws ServletException, IOException {
        try {
          switch (req.getServletPath()) {
            case "/ok":
              try (PreparedStatement p = db.prepareStatement(
                  "select name\n    from item\n   where id = ?\n     and name <> 'q\"\\'")) {
                p.setInt(1, 1);
                p.executeQuery().close();
              }
              break;
            case "/fail":
              try (Statement s = db.createStatement()) {
                s.executeQuery("select * from missing_table");
              }
              break;
            case "/boom":
              throw new IllegalStateException("boom");
            case "/bind":
              try (PreparedStatement p = db.prepareStatement(
                  "select name from item where id = ? and name <> ? and name <> '?' and name <> ?")) {
                p.setInt(1, 7);
                p.setString(2, "it's");
                p.setNull(3, Types.VARCHAR);
                p.executeQuery().close();
                p.clearParameters();
                p.setInt(1, 8);
                try {
                  p.executeQuery().close(); // 2·3번을 안 넣었으니 Derby가 거절한다
                } catch (SQLException expected) {
                  // 구간에 에러로 남는지만 본다
                }
              }
              break;
            case "/long": // MyBatis 동적 SQL처럼 긴 문장(5,000자 넘음)도 잘리지 않아야 한다
              StringBuilder in = new StringBuilder("select name from item where id in (0");
              for (int i = 1; i <= 1200; i++) in.append(", ").append(i);
              try (Statement s = db.createStatement()) {
                s.executeQuery(in.append(") and name <> 'end'").toString()).close();
              }
              break;
            case "/longslow": // 긴 SQL 뒤 멈춘 요청: 처리 중 목록의 마지막 호출은 짧게 잘려야 한다
              StringBuilder in2 = new StringBuilder("select name from item where id in (0");
              for (int i = 1; i <= 1200; i++) in2.append(", ").append(i);
              try (Statement s = db.createStatement()) {
                s.executeQuery(in2.append(")").toString()).close();
              }
              Thread.sleep(1500);
              break;
            case "/heavy": // 긴 SQL(약 45,000자) 1000번: 보낼 수 없는 구간까지 힙에 쌓으면 -Xmx96m을 넘는다
              StringBuilder in3 = new StringBuilder("select name from item where id = ? and id in (0");
              for (int i = 1; i <= 8000; i++) in3.append(", ").append(i);
              try (PreparedStatement p = db.prepareStatement(in3.append(")").toString())) {
                for (int i = 0; i < 1000; i++) {
                  p.setInt(1, i);
                  p.executeQuery().close();
                }
              }
              break;
            case "/many": // N+1: 한글이 섞인 긴 SQL 1100번 → 그대로 보내면 수집 서버 1MB 한도를 넘는다
              StringBuilder pad = new StringBuilder();
              for (int i = 0; i < 600; i++) pad.append('가');
              try (PreparedStatement p = db.prepareStatement(
                  "select name from item where id = ? and name <> '" + pad + "'")) {
                for (int i = 0; i < 1100; i++) {
                  p.setInt(1, i);
                  p.executeQuery().close();
                }
              }
              break;
            case "/http":
              call(stub + "/ok", true);   // 코드 먼저, 그다음 본문
              call(stub + "/err", false); // 본문 먼저 → 500 예외 → 코드 확인
              call(stub + "/nf", true);   // 404
              call("https://127.0.0.1:" + deadPort() + "/", false); // 연결 실패, https 위임 객체
              post(stub + "/ok");                                  // RestTemplate처럼 getOutputStream에서 연결
              connectOnly("http://127.0.0.1:" + deadPort() + "/"); // connect()에서 연결 실패
              break;
            case "/okhttp":
              OkHttpClient ok = new OkHttpClient();
              for (String u : new String[] {stub + "/ok", stub + "/err", "http://127.0.0.1:" + deadPort() + "/"}) {
                try (Response r = ok.newCall(new Request.Builder().url(u).build()).execute()) {
                  r.code();
                } catch (IOException expected) {
                  // 연결 실패
                }
              }
              break;
            case "/req":
              req.getSession().setAttribute("SPRING_SECURITY_CONTEXT", new TestAppSecurityContext());
              break;
            case "/req2":
              req.getSession().setAttribute("loginUser", new TestAppLoginUser());
              break;
            case "/flow":
              orders.save(1);
              break;
            case "/getitem":
              orders.getItem();
              break;
            case "/floodlog": // 구간 한도(1000)를 채운 뒤 남긴 예외도 요청 에러가 되어야 한다
              try (PreparedStatement p = db.prepareStatement("select name from item where id = ?")) {
                for (int i = 0; i < 1001; i++) {
                  p.setInt(1, i);
                  p.executeQuery().close();
                }
              }
              log.error("처리 실패", new IllegalStateException("한도 뒤"));
              break;
            case "/flowfail":
              orders.saveFail();
              break;
            case "/flowslow":
              orders.saveSlow(1);
              break;
            case "/caught": // 잡아서 로그만 남기고 200
              try {
                throw new IllegalStateException("재고 없음");
              } catch (IllegalStateException e) {
                log.error("주문 저장 실패", e);
              }
              break;
            case "/errlog":
              log.error("결재 실패 id={}", 7);
              break;
            case "/printed":
              new IllegalArgumentException("잘못된 값").printStackTrace();
              break;
            case "/warn":
              log.warn("경고", new IllegalStateException("w"));
              break;
            case "/twice":
              log.error("첫째", new RuntimeException("a"));
              log.error("둘째", new RuntimeException("b"));
              break;
            case "/slow":
              Thread.sleep(1500);
              break;
            default: // /hello, /app.js
              break;
          }
          res.getWriter().write("ok");
        } catch (SQLException | InterruptedException e) {
          throw new ServletException(e);
        }
      }
    });
    ctx.addServletMappingDecoded("/", "app");
    tomcat.start();
    System.out.println("READY");
    tomcat.getServer().await();
  }

  // 앱에서 흔한 두 순서: 코드를 먼저 보고 본문 열기, 본문을 먼저 열고 실패하면 코드 보기. 어느 쪽이든 구간은 하나여야 한다.
  static void call(String url, boolean codeFirst) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(2000);
      if (codeFirst && c.getResponseCode() >= 400) return;
      c.getInputStream().close();
    } catch (IOException e) {
      try {
        if (c != null) c.getResponseCode();
      } catch (IOException ignored) {
        // 연결 실패
      }
    }
  }

  // RestTemplate(SimpleBufferingClientHttpRequest)와 같은 순서: 고정 길이 → getOutputStream으로 연결·본문 → 응답 코드
  static void post(String url) {
    try {
      HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
      byte[] body = "x".getBytes("UTF-8");
      c.setRequestMethod("POST");
      c.setDoOutput(true);
      c.setFixedLengthStreamingMode(body.length);
      try (java.io.OutputStream out = c.getOutputStream()) {
        out.write(body);
      }
      c.getResponseCode();
    } catch (IOException ignored) {
      // 테스트가 구간으로 확인한다
    }
  }

  static void connectOnly(String url) {
    try {
      HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(2000);
      c.connect();
      c.getResponseCode();
    } catch (IOException expected) {
      // 연결 실패
    }
  }

  static int deadPort() throws IOException {
    try (ServerSocket s = new ServerSocket(0)) {
      return s.getLocalPort(); // 닫고 돌려주므로 연결하면 거절된다
    }
  }
}

// 앱 메서드 흐름 테스트용. 이름이 앱 패키지(TestApp)로 시작하고 Controller·ServiceImpl로 끝나야 계측된다.
class TestAppOrderController {
  private final TestAppOrderServiceImpl service;

  TestAppOrderController(TestAppOrderServiceImpl service) {
    this.service = service;
  }

  public String save(int id) {
    return service.saveOrder(id);
  }

  public String getItem() { // @GetMapping getAcnutList()처럼 getter 모양의 요청 처리 메서드: 컨트롤러에서는 줄이 있어야 한다
    return service.saveOrder(1);
  }

  public String saveFail() {
    try {
      return service.failOrder();
    } catch (IllegalStateException e) {
      return "fail"; // 잡고 로그는 안 남긴다
    }
  }

  public String saveSlow(int id) throws InterruptedException {
    return service.saveSlow(id);
  }
}

class TestAppOrderServiceImpl {
  private final org.apache.ibatis.session.SqlSessionFactory factory;
  private int count;

  TestAppOrderServiceImpl(org.apache.ibatis.session.SqlSessionFactory factory) {
    this.factory = factory;
  }

  public int getCount() { // getter: 구간이 되면 안 된다
    return count;
  }

  public String saveOrder(int id) {
    count = getCount() + 1;
    try (org.apache.ibatis.session.SqlSession s = factory.openSession(true)) {
      return s.getMapper(TestAppItemMapper.class).name(id);
    }
  }

  public String failOrder() {
    throw new IllegalStateException("재고 없음");
  }

  public String saveSlow(int id) throws InterruptedException {
    String name = saveOrder(id);
    pause(); // SQL 뒤 메서드에서 멈춤: 처리 중 목록의 마지막 호출은 그래도 SQL이어야 한다
    return name;
  }

  public void pause() throws InterruptedException {
    Thread.sleep(1500);
  }
}

interface TestAppItemMapper {
  @org.apache.ibatis.annotations.Select("select name from item where id = #{id}")
  String name(int id);
}

// 세션 속성으로 넣을 가짜 Spring Security 컨텍스트와 로그인 사용자. 공개 클래스가 아니어도 읽혀야 한다.
class TestAppSecurityContext {
  public TestAppAuth getAuthentication() {
    return new TestAppAuth();
  }
}

class TestAppAuth {
  public String getName() {
    return "hong01";
  }
}

class TestAppLoginUser {
  public String getUserId() {
    return "kim02";
  }
}
