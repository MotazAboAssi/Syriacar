# Domain module boundary

Authorized vertical slices belong here, with focused domain/application services,
HTTP adapters, contracts, and colocated UI. Domain/server services must not import
Next.js route handlers or UI; route handlers only bind the module's HTTP surface.

`guest-inspection/` implements first explicit guest inspection confirmation:
locality, active/open provider matching, guest validation, and transactional
request/notification creation. It adds no authentication, delivery, or other
application workflows.