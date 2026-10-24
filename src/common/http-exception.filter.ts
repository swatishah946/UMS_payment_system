import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Every error leaves the api in the same shape:
 * { statusCode, code, message, path, timestamp }
 * so the ERP/frontend can switch on `code` instead of parsing messages.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message: string | string[] = 'Something went wrong';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as
        string | { code?: string; message?: string | string[] };

      if (typeof body === 'string') {
        message = body;
      } else {
        message = body.message ?? exception.message;
        // class-validator errors come as a list of messages without a code
        code = body.code ?? (Array.isArray(body.message) ? 'VALIDATION_ERROR' : HttpStatus[status]);
      }
    } else {
      // unexpected error: log the details, don't leak them to the client
      this.logger.error(
        `${req.method} ${req.url} failed`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(status).json({
      statusCode: status,
      code,
      message,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
