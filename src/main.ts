import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  // rawBody is needed to verify cashfree webhook signatures
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  configureApp(app);

  // demo page for trying the flow in a browser (public/index.html)
  app.useStaticAssets(join(__dirname, '..', 'public'));

  const swagger = new DocumentBuilder()
    .setTitle('UMS Payments API')
    .setDescription('Cashfree payment module for the University Management System')
    .setVersion('1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
