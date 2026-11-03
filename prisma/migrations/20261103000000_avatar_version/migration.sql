-- AlterTable
ALTER TABLE "User" ADD COLUMN "avatarUpdatedAt" DATETIME;

-- Quem já tem foto ganha a data da última edição do perfil como versão do endereço da foto.
UPDATE "User" SET "avatarUpdatedAt" = "updatedAt" WHERE "avatarUrl" IS NOT NULL;
