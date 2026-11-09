import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { ContractsController } from './contracts.controller.js';
import { ContractsService } from './contracts.service.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import type { CreateContractDto } from './dto/create-contract.dto.js';
import type { SignContractDto } from './dto/sign-contract.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const makeRequest = (
  userId = 7,
  role: Role = Role.APPLICANT,
  headers: Record<string, string> = {},
) => ({
  user: { user_id: userId, role },
  headers,
  socket: { remoteAddress: '10.0.0.5' },
  ip: '10.0.0.5',
});

describe('ContractsController', () => {
  let controller: ContractsController;
  let serviceMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    serviceMock = {
      createContract: vi.fn(),
      getMyContracts: vi.fn(),
      verifyContract: vi.fn(),
      findAll: vi.fn(),
      requestContractChanges: vi.fn(),
      signContract: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ContractsController],
      providers: [
        {
          provide: ContractsService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    controller = module.get<ContractsController>(ContractsController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  it('delegates create with the authenticated user', () => {
    const request = makeRequest(2, Role.GRANTOR);
    const dto = { contract_number: 'CTX-001' } as CreateContractDto;
    serviceMock.createContract.mockReturnValue({ contract_id: 77 });

    void controller.create(request, dto);

    expect(serviceMock.createContract).toHaveBeenCalledWith(2, dto);
  });

  it('delegates getMyContracts with the authenticated user', () => {
    void controller.getMyContracts(makeRequest());

    expect(serviceMock.getMyContracts).toHaveBeenCalledWith(7);
  });

  it('delegates verifyContract with the certificate param', () => {
    void controller.verifyContract('VIA-CERT-2026-ABCDEF12');

    expect(serviceMock.verifyContract).toHaveBeenCalledWith(
      'VIA-CERT-2026-ABCDEF12',
    );
  });

  it('delegates findAll with the optional status filter', () => {
    void controller.findAll({ status: 'SIGNED' });

    expect(serviceMock.findAll).toHaveBeenCalledWith('SIGNED');
  });

  it('delegates requestChanges with the authenticated user, id, and dto', () => {
    const request = makeRequest();
    const dto = { reason: 'Typo' };

    void controller.requestChanges(request, 77, dto);

    expect(serviceMock.requestContractChanges).toHaveBeenCalledWith(7, 77, dto);
  });

  it('delegates sign with the buffer, base64 body, and inferred signer identity', () => {
    const request = makeRequest(7, Role.SCHOLAR, {
      'x-forwarded-for': '1.2.3.4, 10.0.0.5',
      'user-agent': 'TestAgent 1.0',
    });
    const signatureFile = { buffer: Buffer.from('signature') };
    const dto = { signature_base64: 'base64data' } as SignContractDto;

    void controller.sign(
      request,
      77,
      signatureFile as Express.Multer.File,
      dto,
    );

    expect(serviceMock.signContract).toHaveBeenCalledWith(
      7,
      77,
      objectMatching({
        signatureBuffer: expect.any(Buffer),
        signatureBase64: 'base64data',
        signerIp: '1.2.3.4',
        signerUserAgent: 'TestAgent 1.0',
      }),
    );
  });

  it('falls back to the socket remote address for the signer ip', () => {
    const request = makeRequest(7, Role.SCHOLAR, {});

    void controller.sign(request, 77, undefined, {
      signature_base64: 'base64data',
    });

    expect(serviceMock.signContract).toHaveBeenCalledWith(
      7,
      77,
      objectMatching({ signerIp: '10.0.0.5' }),
    );
  });

  describe('authorization metadata', () => {
    const handlerFor = (name: string) => {
      const prototype = ContractsController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return prototype[name];
    };
    const rolesFor = (handler: (...args: any[]) => unknown) =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    it('restricts contract creation to admins and grantors', () => {
      expect(rolesFor(handlerFor('create'))).toEqual([
        Role.ADMIN,
        Role.GRANTOR,
      ]);
    });

    it('restricts contract listing to staff roles', () => {
      expect(rolesFor(handlerFor('findAll'))).toEqual([
        Role.ADMIN,
        Role.GRANTOR,
        Role.COORDINATOR,
      ]);
    });

    it('restricts request-changes and sign to applicants and scholars', () => {
      for (const name of ['getMyContracts', 'requestChanges', 'sign']) {
        expect(rolesFor(handlerFor(name))).toEqual([
          Role.APPLICANT,
          Role.SCHOLAR,
        ]);
      }
    });

    it('leaves the public certificate verification route unauthenticated', () => {
      expect(rolesFor(handlerFor('verifyContract'))).toBeUndefined();
    });
  });
});
