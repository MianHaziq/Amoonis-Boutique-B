-- Rename UserContact.title -> subject and UserContact.description -> message.
-- Field names now align with the user-facing "subject + message" form.

ALTER TABLE "UserContact" RENAME COLUMN "title"       TO "subject";
ALTER TABLE "UserContact" RENAME COLUMN "description" TO "message";
