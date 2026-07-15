import { Icon } from '@/components/Common/Iconify/icons';
import { Tooltip } from "@heroui/react";
import { motion } from "motion/react";
import { observer } from "mobx-react-lite";
import { useTranslation } from 'react-i18next';

export const IconButton = observer(({ tooltip, icon, onClick, classNames, children, size = 20, containerSize }: {
  tooltip: string | React.ReactNode,
  icon: string | any,
  onClick?: (e) => void,
  classNames?: {
    base?: string,
    icon?: string,
  },
  children?: any,
  size?: number,
  containerSize?: number
}) => {
  const { t } = useTranslation()
  const label = typeof tooltip === 'string' ? t(tooltip) : undefined
  return (
    <Tooltip content={label ?? tooltip} placement="bottom" delay={300}>
      <motion.div
        role="button"
        aria-label={label}
        tabIndex={0}
        whileTap={{ y: 1 }}
        className={`hover:bg-hover !transition-all duration-200 cursor-pointer rounded-md flex items-center justify-center ${classNames?.base}`}
        style={{
          width: containerSize || size + 3,
          height: containerSize || size + 3
        }}
        onClick={e => {
          onClick?.(e)
        }}
        onKeyDown={event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.currentTarget.click();
        }}
      >
        {typeof icon === 'string' && icon.includes('svg') ? (
          <div dangerouslySetInnerHTML={{ __html: icon }} className={`w-[${size}px] h-[${size}px] flex items-center justify-center ${classNames?.icon}`} />
        ) : (
          <Icon icon={icon} className={classNames?.icon} width={size} height={size} />
        )}
        {children}
      </motion.div>
    </Tooltip>
  )
})
