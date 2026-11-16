# Minimal Google Closure Compiler image (official jar from Maven Central).
FROM eclipse-temurin:21-jre-alpine

ARG CLOSURE_VERSION=v20261109
RUN wget -q -O /opt/closure-compiler.jar \
      "https://repo1.maven.org/maven2/com/google/javascript/closure-compiler/${CLOSURE_VERSION}/closure-compiler-${CLOSURE_VERSION}.jar" \
 && java -jar /opt/closure-compiler.jar --version

WORKDIR /work
ENTRYPOINT ["java", "-jar", "/opt/closure-compiler.jar"]
