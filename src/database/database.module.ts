import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('mongo.uri'),
        dbName: 'autonomous-marketing-agent',
        connectionFactory: (connection) => {
          connection.on('connected', () =>
            console.log('MongoDB connected'),
          );
          connection.on('error', (err: Error) =>
            console.error('MongoDB error:', err.message),
          );
          connection.on('disconnected', () =>
            console.warn('MongoDB disconnected'),
          );
          return connection;
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
