# syntax=docker/dockerfile:1.7
# FinTechBankX service image (same shape as loan-lifecycle-core PR #14):
# multi-stage build from source, layered Spring Boot jar, non-root UID 10001,
# API on 8080 and actuator on 8081. Tests run in CI, not here.
FROM eclipse-temurin:23-jdk AS build
WORKDIR /workspace
COPY gradlew settings.gradle build.gradle gradle.properties ./
COPY gradle gradle
COPY src src
RUN ./gradlew --no-daemon bootJar -x test \
 && java -Djarmode=tools -jar build/libs/*.jar extract --layers --launcher --destination /workspace/extracted

FROM eclipse-temurin:23-jre AS runtime
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=build /workspace/extracted/dependencies/ ./
COPY --from=build /workspace/extracted/spring-boot-loader/ ./
COPY --from=build /workspace/extracted/snapshot-dependencies/ ./
COPY --from=build /workspace/extracted/application/ ./
USER 10001:10001
EXPOSE 8080 8081
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
