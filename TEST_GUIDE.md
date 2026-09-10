# Testing Preparation

Required tests:

Auth:
- register creates user
- login returns JWT
- invalid password rejected

Event:
- create event
- list with pagination
- search event
- update event
- delete event

Security:
- protected routes reject missing token
- role restrictions work
