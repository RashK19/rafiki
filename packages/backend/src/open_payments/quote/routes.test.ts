import assert from 'assert'
import { faker } from '@faker-js/faker'
import jestOpenAPI from 'jest-openapi'
import { v4 as uuid } from 'uuid'
import { IocContract } from '@adonisjs/fold'

import { createTestApp, TestContainer } from '../../tests/app'
import { Config, IAppConfig } from '../../config/app'
import { initIocContainer } from '../..'
import { AppServices, CreateContext } from '../../app'
import { truncateTables } from '../../tests/tableManager'
import { QuoteService } from './service'
import { Quote } from './model'
import { QuoteRoutes, CreateBody } from './routes'
import { Amount, serializeAmount } from '../amount'
import { PaymentPointer } from '../payment_pointer/model'
import {
  getRouteTests,
  setup as setupContext
} from '../payment_pointer/model.test'
import { createAsset, randomAsset } from '../../tests/asset'
import { createPaymentPointer } from '../../tests/paymentPointer'
import { createQuote } from '../../tests/quote'

describe('Quote Routes', (): void => {
  let deps: IocContract<AppServices>
  let appContainer: TestContainer
  let quoteService: QuoteService
  let config: IAppConfig
  let quoteRoutes: QuoteRoutes
  let paymentPointer: PaymentPointer

  const receiver = `https://wallet2.example/bob/incoming-payments/${uuid()}`
  const asset = randomAsset()
  const debitAmount: Amount = {
    value: BigInt(123),
    assetCode: asset.code,
    assetScale: asset.scale
  }

  const createPaymentPointerQuote = async ({
    paymentPointerId,
    client
  }: {
    paymentPointerId: string
    client?: string
  }): Promise<Quote> => {
    return await createQuote(deps, {
      paymentPointerId,
      receiver,
      debitAmount: {
        value: BigInt(56),
        assetCode: asset.code,
        assetScale: asset.scale
      },
      client,
      validDestination: false
    })
  }

  beforeAll(async (): Promise<void> => {
    config = Config
    deps = await initIocContainer(config)
    appContainer = await createTestApp(deps)
    config = await deps.use('config')
    quoteRoutes = await deps.use('quoteRoutes')
    quoteService = await deps.use('quoteService')
    const { resourceServerSpec } = await deps.use('openApi')
    jestOpenAPI(resourceServerSpec)
  })

  beforeEach(async (): Promise<void> => {
    const { id: assetId } = await createAsset(deps, {
      code: debitAmount.assetCode,
      scale: debitAmount.assetScale
    })
    paymentPointer = await createPaymentPointer(deps, {
      assetId
    })
  })

  afterEach(async (): Promise<void> => {
    await truncateTables(appContainer.knex)
  })

  afterAll(async (): Promise<void> => {
    await appContainer.shutdown()
  })

  describe('get', (): void => {
    getRouteTests({
      getPaymentPointer: async () => paymentPointer,
      createModel: async ({ client }) =>
        createPaymentPointerQuote({
          paymentPointerId: paymentPointer.id,
          client
        }),
      get: (ctx) => quoteRoutes.get(ctx),
      getBody: (quote) => {
        return {
          id: `${paymentPointer.url}/quotes/${quote.id}`,
          paymentPointer: paymentPointer.url,
          receiver: quote.receiver,
          debitAmount: serializeAmount(quote.debitAmount),
          receiveAmount: serializeAmount(quote.receiveAmount),
          createdAt: quote.createdAt.toISOString(),
          expiresAt: quote.expiresAt.toISOString()
        }
      },
      urlPath: Quote.urlPath
    })
  })

  describe('create', (): void => {
    let options: CreateBody

    const setup = ({
      client
    }: {
      client?: string
    }): CreateContext<CreateBody> =>
      setupContext<CreateContext<CreateBody>>({
        reqOpts: {
          body: options,
          method: 'POST',
          url: `/quotes`
        },
        paymentPointer,
        client
      })

    test('returns error on invalid debitAmount asset', async (): Promise<void> => {
      options = {
        receiver,
        debitAmount: {
          ...debitAmount,
          value: debitAmount.value.toString(),
          assetScale: debitAmount.assetScale + 1
        }
      }
      const ctx = setup({})
      await expect(quoteRoutes.create(ctx)).rejects.toMatchObject({
        message: 'invalid amount',
        status: 400
      })
    })

    test('returns 500 on error', async (): Promise<void> => {
      jest
        .spyOn(quoteService, 'create')
        .mockRejectedValueOnce(new Error('unexpected'))
      const ctx = setup({})
      await expect(quoteRoutes.create(ctx)).rejects.toMatchObject({
        message: 'Error trying to create quote',
        status: 500
      })
    })

    describe.each`
      client                                        | description
      ${faker.internet.url({ appendSlash: false })} | ${'client'}
      ${undefined}                                  | ${'no client'}
    `('returns the quote on success ($description)', ({ client }): void => {
      test.each`
        debitAmount  | receiveAmount | description
        ${'123'}     | ${undefined}  | ${'debitAmount'}
        ${undefined} | ${'56'}       | ${'receiveAmount'}
      `(
        '$description',
        async ({ debitAmount, receiveAmount }): Promise<void> => {
          options = {
            receiver
          }
          if (debitAmount)
            options.debitAmount = {
              value: debitAmount,
              assetCode: asset.code,
              assetScale: asset.scale
            }
          if (receiveAmount)
            options.receiveAmount = {
              value: receiveAmount,
              assetCode: asset.code,
              assetScale: asset.scale
            }
          const ctx = setup({ client })
          let quote: Quote | undefined
          const quoteSpy = jest
            .spyOn(quoteService, 'create')
            .mockImplementationOnce(async (opts) => {
              quote = await createQuote(deps, {
                ...opts,
                validDestination: false,
                client
              })
              return quote
            })
          await expect(quoteRoutes.create(ctx)).resolves.toBeUndefined()
          expect(quoteSpy).toHaveBeenCalledWith({
            paymentPointerId: paymentPointer.id,
            receiver,
            debitAmount: options.debitAmount && {
              ...options.debitAmount,
              value: BigInt(options.debitAmount.value)
            },
            receiveAmount: options.receiveAmount && {
              ...options.receiveAmount,
              value: BigInt(options.receiveAmount.value)
            },
            client
          })
          expect(ctx.response).toSatisfyApiSpec()
          const quoteId = (
            (ctx.response.body as Record<string, unknown>)['id'] as string
          )
            .split('/')
            .pop()
          assert.ok(quote)
          expect(ctx.response.body).toEqual({
            id: `${paymentPointer.url}/quotes/${quoteId}`,
            paymentPointer: paymentPointer.url,
            receiver: quote.receiver,
            debitAmount: {
              ...quote.debitAmount,
              value: quote.debitAmount.value.toString()
            },
            receiveAmount: {
              ...quote.receiveAmount,
              value: quote.receiveAmount.value.toString()
            },
            createdAt: quote.createdAt.toISOString(),
            expiresAt: quote.expiresAt.toISOString()
          })
        }
      )

      test('receiver.incomingAmount', async (): Promise<void> => {
        options = {
          receiver
        }
        const ctx = setup({ client })
        let quote: Quote | undefined
        const quoteSpy = jest
          .spyOn(quoteService, 'create')
          .mockImplementationOnce(async (opts) => {
            quote = await createQuote(deps, {
              ...opts,
              validDestination: false,
              client
            })
            return quote
          })
        await expect(quoteRoutes.create(ctx)).resolves.toBeUndefined()
        expect(quoteSpy).toHaveBeenCalledWith({
          paymentPointerId: paymentPointer.id,
          receiver,
          client
        })
        expect(ctx.response).toSatisfyApiSpec()
        const quoteId = (
          (ctx.response.body as Record<string, unknown>)['id'] as string
        )
          .split('/')
          .pop()
        assert.ok(quote)
        expect(ctx.response.body).toEqual({
          id: `${paymentPointer.url}/quotes/${quoteId}`,
          paymentPointer: paymentPointer.url,
          receiver: options.receiver,
          debitAmount: {
            ...quote.debitAmount,
            value: quote.debitAmount.value.toString()
          },
          receiveAmount: {
            ...quote.receiveAmount,
            value: quote.receiveAmount.value.toString()
          },
          createdAt: quote.createdAt.toISOString(),
          expiresAt: quote.expiresAt.toISOString()
        })
      })
    })
  })
})
