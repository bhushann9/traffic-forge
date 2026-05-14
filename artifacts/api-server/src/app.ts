import path from 'path';
import express, { type Express } from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import router from './routes';
import { logger, genReqId } from './shared/lib/logger';

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    // Use our custom correlation ID generator (honors x-correlation-id inbound)
    genReqId,
    // Surface the correlation ID directly under `correlationId` for easier filtering
    customProps: (req) => ({ correlationId: req.id }),
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split('?')[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors({ exposedHeaders: ['x-correlation-id'] }));

// Add a basic GET route for the root path
app.get('/', (_req, res) => {
  res.status(200).send('OK');
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api', router);

if (process.env.NODE_ENV === 'production') {
  const frontendDist = path.resolve(process.cwd(), '../traffic-forge/dist/public');
  app.use(express.static(frontendDist));
  app.get('/*path', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

export default app;
