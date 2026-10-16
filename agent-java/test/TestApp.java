import java.io.File;
import java.io.IOException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.apache.catalina.Context;
import org.apache.catalina.startup.Tomcat;

// 에이전트 테스트용 앱: 내장 Tomcat + Derby 메모리 DB. 인자는 포트 하나.
public class TestApp {
  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(args[0]);
    Connection db = DriverManager.getConnection("jdbc:derby:memory:t;create=true");
    try (Statement s = db.createStatement()) { // 요청 밖의 SQL: 기록되면 안 된다
      s.execute("create table item (id int, name varchar(20))");
      s.execute("insert into item values (1, 'a')");
    }

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
}
