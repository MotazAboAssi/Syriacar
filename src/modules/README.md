# Domain module boundary

Authorized vertical slices belong here, with focused domain/application services,
HTTP adapters, contracts, and colocated UI. Domain/server services must not import
Next.js route handlers or UI; route handlers only bind the module's HTTP surface.

`guest-inspection/` implements first explicit guest inspection confirmation:
locality, active/open provider matching, guest validation, and transactional
request/notification creation. It adds no authentication, delivery, or other
application workflows.

`guest-towing/` implements the authorized guest-only towing slice: origin/destination,
active/open A/B provider results, consent, transactional first/additional provider
notifications on one request, and read-only manual location message preparation.
Request-bound continuation proofs do not introduce accounts or sessions. Prepared
wa.me links require user action; no platform delivery, GPS/maps, permanent business
seeds, schema changes or Build 6 functionality is included.