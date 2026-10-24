import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  // rawBody is needed to verify cashfree webhook signatures
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);

  const swagger = new DocumentBuilder()
    .setTitle('UMS Payments API')
    .setDescription('Cashfree payment module for the University Management System')
    .setVersion('1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
