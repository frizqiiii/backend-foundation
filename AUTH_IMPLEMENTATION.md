# JWT Authentication Implementation

Target flow:

1. Register
- Validate input with Zod
- Hash password with bcrypt
- Save user

2. Login
- Compare password
- Generate JWT access token

3. Protected routes
- Verify JWT middleware
- Attach user information to request

Required packages:
- jsonwebtoken
- bcrypt
- zod
