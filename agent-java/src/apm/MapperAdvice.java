package apm;

import net.bytebuddy.asm.Advice;
import org.apache.ibatis.mapping.MappedStatement;

// MyBatis Executor의 query(4개 인자)·update 앞뒤. 매퍼 인터페이스는 몸체가 없어 계측할 수 없으므로
// 모든 매퍼 호출과 sqlSession.selectList("id") 직접 호출이 지나는 이곳에서 SQL ID를 얻는다.
public final class MapperAdvice {
  @Advice.OnMethodEnter(suppress = Throwable.class)
  static Tracer.Span enter(@Advice.Argument(0) MappedStatement ms) {
    return Tracer.mapperStart(ms.getId());
  }

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(@Advice.Enter Tracer.Span span, @Advice.Thrown Throwable thrown) {
    Tracer.mapperEnd(span, thrown);
  }
}
