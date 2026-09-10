import { hasPermission, getPermissionsForRole } from './permissions';

describe('permissions', () => {
  it('USER punya event.read TAPI tidak punya event.create', () => {
    expect(hasPermission('USER', 'event.read')).toBe(true);
    expect(hasPermission('USER', 'event.create')).toBe(false);
  });

  it('ADMIN punya user.manage sesuai contoh di spesifikasi', () => {
    expect(hasPermission('ADMIN', 'user.manage')).toBe(true);
  });

  it('ORGANIZER punya event.create/delete TAPI tidak punya user.manage', () => {
    expect(hasPermission('ORGANIZER', 'event.create')).toBe(true);
    expect(hasPermission('ORGANIZER', 'event.delete')).toBe(true);
    expect(hasPermission('ORGANIZER', 'user.manage')).toBe(false);
  });

  it('USER TIDAK punya user.manage', () => {
    expect(hasPermission('USER', 'user.manage')).toBe(false);
  });

  it('HANYA ADMIN yang punya event.moderate/product.moderate (kapabilitas bertindak atas resource milik orang lain)', () => {
    expect(hasPermission('ADMIN', 'event.moderate')).toBe(true);
    expect(hasPermission('ADMIN', 'product.moderate')).toBe(true);
    expect(hasPermission('ORGANIZER', 'event.moderate')).toBe(false);
    expect(hasPermission('USER', 'product.moderate')).toBe(false);
  });

  it('HANYA ADMIN yang punya upload.moderate', () => {
    expect(hasPermission('ADMIN', 'upload.moderate')).toBe(true);
    expect(hasPermission('USER', 'upload.moderate')).toBe(false);
    expect(hasPermission('ORGANIZER', 'upload.moderate')).toBe(false);
  });
});

describe('getPermissionsForRole', () => {
  it('mengembalikan daftar permission LENGKAP milik role, sinkron dengan hasPermission', () => {
    const adminPermissions = getPermissionsForRole('ADMIN');

    expect(adminPermissions).toContain('tenant.manage');
    expect(adminPermissions).toContain('dashboard.read');
    for (const permission of adminPermissions) {
      expect(hasPermission('ADMIN', permission)).toBe(true);
    }
  });

  it('USER mendapat daftar minimal (3 permission dasar saja)', () => {
    expect(getPermissionsForRole('USER')).toEqual(['event.read', 'product.read', 'upload.create']);
  });
});
