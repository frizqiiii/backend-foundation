import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3StorageProvider } from './s3-storage.provider';
import { s3Client } from '../../config/s3';

jest.mock('../../config/s3', () => ({ s3Client: { send: jest.fn() } }));
jest.mock('../../config/env', () => ({
  env: { AWS_S3_BUCKET_NAME: 'my-bucket', AWS_REGION: 'ap-southeast-1' },
}));

const mockedSend = s3Client.send as jest.Mock;

describe('s3StorageProvider', () => {
  describe('upload', () => {
    it('mengirim PutObjectCommand dengan Bucket/Key/Body/ContentType yang benar', async () => {
      mockedSend.mockResolvedValue({});
      const body = Buffer.from('data-gambar');

      const result = await s3StorageProvider.upload({
        key: 'foo.png',
        body,
        contentType: 'image/png',
      });

      expect(mockedSend).toHaveBeenCalledWith(expect.any(PutObjectCommand));
      const command = mockedSend.mock.calls[0][0] as PutObjectCommand;
      expect(command.input).toEqual({
        Bucket: 'my-bucket',
        Key: 'foo.png',
        Body: body,
        ContentType: 'image/png',
      });
      expect(result).toEqual({
        url: 'https://my-bucket.s3.ap-southeast-1.amazonaws.com/foo.png',
      });
    });

    it('P5 — melempar ulang error dari S3 apa adanya (tidak ditelan diam-diam)', async () => {
      mockedSend.mockRejectedValue(new Error('AccessDenied'));

      await expect(
        s3StorageProvider.upload({ key: 'x', body: Buffer.from('x'), contentType: 'image/png' })
      ).rejects.toThrow('AccessDenied');
    });
  });

  describe('delete', () => {
    it('mengirim DeleteObjectCommand dengan Bucket/Key yang benar', async () => {
      mockedSend.mockResolvedValue({});

      await s3StorageProvider.delete('foo.png');

      expect(mockedSend).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
      const command = mockedSend.mock.calls[0][0] as DeleteObjectCommand;
      expect(command.input).toEqual({ Bucket: 'my-bucket', Key: 'foo.png' });
    });

    it('P5 — melempar ulang error dari S3 apa adanya (BUKAN idempotent seperti local-storage-provider)', async () => {
      mockedSend.mockRejectedValue(new Error('NoSuchKey'));

      await expect(s3StorageProvider.delete('tidak-ada')).rejects.toThrow('NoSuchKey');
    });
  });
});
