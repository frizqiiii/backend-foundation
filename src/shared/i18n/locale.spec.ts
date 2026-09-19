import type { Request, Response } from 'express';
import {
  DEFAULT_LOCALE,
  getRequestLocale,
  getResponseLocale,
  isLocale,
  resolveLocale,
} from './locale';

describe('resolveLocale (item 2.13)', () => {
  it.each([undefined, '', '   ', '*', 'fr', 'de-DE, ja;q=0.8', 'zz-ZZ;q=1'])(
    'header %p -> default id (tidak ada bahasa yang didukung)',
    (header) => {
      expect(resolveLocale(header)).toBe(DEFAULT_LOCALE);
    }
  );

  it('DEFAULT_LOCALE adalah id (bahasa sumber semua pesan; klien lama tidak terpengaruh)', () => {
    expect(DEFAULT_LOCALE).toBe('id');
  });

  it.each([
    ['en', 'en'],
    ['EN', 'en'],
    ['en-US', 'en'],
    ['en-GB,en;q=0.9', 'en'],
    ['id', 'id'],
    ['id-ID', 'id'],
  ])('%p -> %p (hanya subtag utama, case-insensitive)', (header, expected) => {
    expect(resolveLocale(header)).toBe(expected);
  });

  it('bobot q tertinggi menang, bukan urutan', () => {
    expect(resolveLocale('id;q=0.4, en;q=0.9')).toBe('en');
    expect(resolveLocale('en;q=0.3, id;q=0.8')).toBe('id');
  });

  it('bobot sama -> yang lebih dulu disebut menang', () => {
    expect(resolveLocale('en, id')).toBe('en');
    expect(resolveLocale('id, en')).toBe('id');
  });

  it('bahasa tak didukung dengan q tinggi diabaikan, bahasa didukung dipakai', () => {
    expect(resolveLocale('fr;q=1.0, en;q=0.5')).toBe('en');
  });

  it('q=0 berarti "tidak diinginkan" -> diabaikan', () => {
    expect(resolveLocale('en;q=0, id;q=0.1')).toBe('id');
    expect(resolveLocale('en;q=0')).toBe('id');
  });

  it('q yang rusak/tak terbaca tidak melempar error dan dianggap tidak valid', () => {
    expect(() => resolveLocale('en;q=abc')).not.toThrow();
    expect(resolveLocale('en;q=abc')).toBe('en'); // q tak terbaca -> tetap bobot bawaan 1
    expect(resolveLocale(';;;,,,;q=;')).toBe('id');
  });

  it('header berupa array (beberapa header Accept-Language) digabung', () => {
    expect(resolveLocale(['fr', 'en;q=0.8'])).toBe('en');
  });

  it('header sangat panjang tidak dipercaya: hanya 1024 karakter pertama diproses', () => {
    const padding = 'x'.repeat(2000);
    expect(resolveLocale(`fr;q=0.1,${padding},en`)).toBe('id'); // "en" ada di luar batas
  });
});

describe('isLocale', () => {
  it('true hanya untuk id/en', () => {
    expect(isLocale('id')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('EN')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('getResponseLocale / getRequestLocale', () => {
  it('getResponseLocale membaca res.locals.locale', () => {
    expect(getResponseLocale({ locals: { locale: 'en' } } as unknown as Response)).toBe('en');
  });

  it('getResponseLocale defensif: res.locals tidak ada / nilai asing -> default', () => {
    expect(getResponseLocale({} as Response)).toBe('id');
    expect(getResponseLocale({ locals: { locale: 'fr' } } as unknown as Response)).toBe('id');
  });

  it('getRequestLocale: res.locals.locale menang atas header', () => {
    const req = { headers: { 'accept-language': 'id' } } as unknown as Request;
    const res = { locals: { locale: 'en' } } as unknown as Response;
    expect(getRequestLocale(req, res)).toBe('en');
  });

  it('getRequestLocale: tanpa locals -> baca header request langsung (error dilempar sebelum middleware)', () => {
    const req = { headers: { 'accept-language': 'en-US' } } as unknown as Request;
    expect(getRequestLocale(req, {} as Response)).toBe('en');
  });

  it('getRequestLocale: req tanpa headers sama sekali (mock) -> default, tidak melempar', () => {
    expect(getRequestLocale({} as Request, {} as Response)).toBe('id');
  });
});
